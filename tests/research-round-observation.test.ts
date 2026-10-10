import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { hash } from "../src/protocol.js";
import { publishRoundObservation } from "../src/round-observation.js";
import {
  buildRoundObservationSummary,
  collectRoundObservationEvidence,
  buildAccountingBrief,
} from "../src/round-observation-context.js";
const wallet = "0x" + "aa".repeat(20);
function unknown(roundId: string, at: number) {
  return {
    chainId: 97,
    roundId,
    sourceStatus: "FAILED" as const,
    terminalAt: at,
    observedAt: at + 1,
    roster: [{ agentId: "a", wallet }],
    rosterComplete: true,
    predecessorId: null,
    registryHash: null,
    configHash: hash({}),
    openingBoundary: null,
    closingBoundary: null,
    lifecycle: "PENDING" as const,
    wallets: [
      {
        agentId: "a",
        wallet,
        openingSnapshotId: null,
        closingSnapshotId: null,
        proofIds: [],
        captureAttemptIds: [],
        missingReasons: ["OPENING_BASELINE_UNAVAILABLE"],
      },
    ],
    missingReasons: [],
  };
}
test("latest prior UNKNOWN is selected and frozen revision survives a later correction", () => {
  const db = new Store(":memory:");
  try {
    const first = publishRoundObservation(db, unknown("1", 10), null),
      second = publishRoundObservation(db, unknown("2", 20), null);
    const selected = collectRoundObservationEvidence(db, 97, 22, "3")!;
    assert.equal(selected.observation.observationId, second.id);
    assert.equal(selected.observation.network.periodPnlMicros, null);
    publishRoundObservation(
      db,
      { ...unknown("2", 20), observedAt: 30, lifecycle: "COMPLETE" },
      second.id,
    );
    assert.deepEqual(
      collectRoundObservationEvidence(db, 97, 22, "3"),
      selected,
    );
    assert.equal(
      collectRoundObservationEvidence(db, 97, 22, "2")?.observation
        .observationId,
      first.id,
    );
    assert.equal(collectRoundObservationEvidence(db, 1, 22), null);
    const raw = db.get<any>("round-observation", first.id);
    raw.currency = "micro-USDT";
    db.put("round-observation", first.id, raw);
    assert.throws(
      () => buildRoundObservationSummary(db, first.id),
      /INTEGRITY/,
    );
  } finally {
    db.close();
  }
});
test("accounting brief matches case-insensitive representative wallet without substituting network or inventing lifetime returns", () => {
  const feedback: any = {
    version: "execution-feedback-context/1",
    currency: "micro-USD",
    roundId: "8364",
    chainId: 97,
    omittedWalletCount: 0,
    network: {
      observationId: "1".repeat(64),
      status: "KNOWN",
      periodPnlMicros: "2500000",
      missingWallets: [],
    },
    wallets: [
      {
        observationId: "2".repeat(64),
        agentId: "a",
        wallet,
        jobId: "job",
        planId: "plan",
        openingSnapshotId: null,
        closingSnapshotId: null,
        fillIds: [],
        omittedFillCount: 0,
        status: "KNOWN",
        navDeltaMicros: "1234567",
        periodPnlMicros: "1234567",
        missingReasons: [],
      },
    ],
  };
  const context: any = {
    chainId: 97,
    portfolioIdentity: { wallet: wallet.toUpperCase().replace("0X", "0x") },
    executionFeedback: feedback,
    evidence: [],
  };
  const brief = buildAccountingBrief(context);
  assert.equal(
    brief.executionWindow?.representativeWallet?.periodPnlUSD,
    "1.234567",
  );
  assert.equal(brief.executionWindow?.sourceRoundId, "8364");
  assert.equal(brief.executionWindow?.windowLabel, "BOUNDARIES_UNAVAILABLE");
  assert.equal(brief.lifetimeUSDT.costBasis, null);
  assert.equal(brief.lifetimeUSDT.realizedPnl, null);
  assert.equal(brief.lifetimeUSDT.unrealizedPnl, null);
  context.portfolioIdentity.wallet = "0x" + "bb".repeat(20);
  assert.equal(
    buildAccountingBrief(context).executionWindow?.representativeWallet,
    null,
  );
});

import {
  observationFixture,
  address,
} from "./helpers/round-observation-fixtures.js";
import { PerformanceLedger } from "../src/performance-ledger.js";
import { promptSnapshot } from "../src/research-context.js";
import { stableFixture } from "./helpers/stable-qsp.js";
test("offline three-wallet abstention observes real aggregate and freezes later QSP accounting independently", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    for (let i = 0; i < 3; i++) f.addAgent("a" + i, 20 + i);
    f.addEpoch("first");
    await f.service().tick();
    assert.equal(
      new PerformanceLedger(db).latest("first", 97, "micro-USD")?.network
        .periodPnL,
      null,
    );
    f.state.now += 10000;
    f.state.block = 20;
    f.state.price = "110000000";
    f.addEpoch("second");
    await f.service().tick();
    const result = collectRoundObservationEvidence(
      db,
      97,
      f.state.now,
      "third",
    )!;
    assert.equal(result.observation.wallets.length, 3);
    assert.equal(result.observation.network.periodPnlMicros, "30000000");
    assert.deepEqual(result.observation.network.periodReturn, {
      numerator: "30000000",
      denominator: "300000000",
    });
    const { context } = await stableFixture();
    const combined: any = {
      ...context,
      chainId: 97,
      roundObservation: result.observation,
      portfolioIdentity: { ...context.portfolioIdentity, wallet: address(21) },
      evidence: [...context.evidence, result.evidence],
    };
    const frozen = hash(combined),
      brief = buildAccountingBrief(combined);
    assert.equal(
      brief.latestTerminalObservation?.representativeWallet?.periodPnlUSD,
      "10.000000",
    );
    assert.equal(
      brief.latestTerminalObservation?.network?.periodPnlUSD,
      "30.000000",
    );
    assert.equal(brief.lifetimeUSDT.costBasis, null);
    for (const role of ["positions", undefined])
      assert.deepEqual(promptSnapshot(combined, role).accountingBrief, brief);
    f.state.now += 10000;
    f.state.block = 30;
    f.addEpoch("third");
    await f.service().tick();
    assert.equal(hash(combined), frozen);
    assert.equal(result.evidence.contentHash, hash(result.observation));
    for (const kind of [
      "stable-wallet-plan",
      "investment-execution-job",
      "wallet-reservation",
      "transaction",
    ])
      assert.equal(db.all(kind).length, 0);
  } finally {
    db.close();
  }
});
test("bounded summary retains full durable 33-wallet missing coverage", () => {
  const db = new Store(":memory:");
  try {
    const input = unknown("many", 10);
    input.roster = Array.from({ length: 33 }, (_, i) => ({
      agentId: "a" + i,
      wallet: address(i + 1),
    }));
    input.wallets = input.roster.map((r) => ({ ...input.wallets[0]!, ...r }));
    const record = publishRoundObservation(db, input, null),
      summary = buildRoundObservationSummary(db, record.id);
    assert.equal(summary.wallets.length, 32);
    assert.equal(summary.omittedWalletCount, 1);
    assert.equal(summary.network.missingWallets.length, 33);
    assert.equal(db.get<any>("round-observation", record.id).roster.length, 33);
  } finally {
    db.close();
  }
});

test("summary rejects a missing head and a detached self-hashed revision", () => {
  const db = new Store(":memory:");
  try {
    const r = publishRoundObservation(db, unknown("1", 10), null);
    db.remove("round-observation-head", hash([97, "1"]));
    assert.throws(() => buildRoundObservationSummary(db, r.id), /HEAD/);
  } finally {
    db.close();
  }
});
