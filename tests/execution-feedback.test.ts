import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { hash } from "../src/protocol.js";
import {
  ExecutionFeedback,
  buildExecutionFeedbackSummary,
} from "../src/execution-feedback.js";
const wallet = "0x0000000000000000000000000000000000000001";
function snapshot(db: Store, block: number, nav: string, gasExcluded = "0") {
  const body = {
    version: "tracked-portfolio/1",
    requestId: `capture${block}`,
    agent: "a",
    wallet,
    chainId: 56,
    observedAt: block * 1000,
    validUntil: block * 1000 + 1000,
    blockNumber: block,
    blockHash: "0x" + String(block).padStart(64, "0"),
    registryHash: "registry",
    reservationSource: "reservation",
    navMicros: nav,
    stableValueMicros: "0",
    availableStableMicros: "0",
    exposures: { BTC: "0", ETH: "0", BNB: nav },
    availableExposures: { BTC: "0", ETH: "0", BNB: nav },
    holdings: [
      {
        asset: "native",
        bucket: "BNB",
        balance: "2000000000000000000",
        reserved: "0",
        gasExcluded,
        valueMicros: nav,
        availableMicros: nav,
        priceMicros: "1000000",
      },
    ],
  };
  const s = { ...body, id: hash(body) };
  db.insert("portfolio-snapshot", s.id, s);
  db.insert("portfolio-capture", body.requestId, {
    status: "DONE",
    snapshotId: s.id,
  });
  return s.id;
}
function setup(db: Store) {
  const openingSnapshotId = snapshot(db, 1, "900000", "100000000000000000"),
    closingSnapshotId = snapshot(db, 3, "1300000", "0");
  const fill = {
    id: hash(["dex-v2-fill/1", 56, "0x" + "a".repeat(64)]),
    version: "dex-v2-fill/1",
    quoteId: "q",
    transactionId: "tx",
    chainId: 56,
    wallet,
    inputAsset: wallet,
    outputAsset: "0x0000000000000000000000000000000000000002",
    amountIn: "123",
    amountOut: "456",
    gasWei: "1000000000000000",
    hash: "0x" + "a".repeat(64),
    block: 2,
    blockHash: "0x" + "b".repeat(64),
  };
  db.insert("dex-v2-fill", fill.id, fill);
  return {
    roundId: "r",
    chainId: 56,
    agentId: "a",
    wallet,
    jobId: "j",
    planId: "p",
    openingSnapshotId,
    closingSnapshotId,
    fillIds: [fill.id],
    cashflow: {
      complete: true,
      netExternalFlowMicros: "200000",
      hasExternalFlows: true,
      provenance: ["confirmed-flow:1"],
    },
  };
}
test("flow-adjusted USD NAV adds excluded gas reserve and does not deduct fill gas twice", () => {
  const db = new Store(":memory:");
  try {
    const input = setup(db),
      feedback = new ExecutionFeedback(db),
      row = feedback.recordWallet(input);
    assert.equal(row.currency, "micro-USD");
    assert.equal(row.openingNavMicros, "1000000");
    assert.equal(row.navDeltaMicros, "300000");
    assert.equal(row.periodPnlMicros, "100000");
    assert.equal(row.status, "KNOWN");
    assert.equal(row.periodReturn, null);
    assert.equal(row.fills[0]!.amountIn, "123");
    assert.equal(row.fills[0]!.amountOut, "456");
    assert.equal(row.fills[0]!.id, input.fillIds[0]);
    assert.deepEqual(feedback.recordWallet(input), row);
    assert.equal(db.all("execution-feedback-wallet").length, 1);
    assert.throws(
      () => feedback.recordWallet({ ...input, planId: "other" }),
      /conflict/i,
    );
  } finally {
    db.close();
  }
});
test("missing flows or incomplete captures never assert profit; explicit no-flow provenance permits a return", () => {
  const db = new Store(":memory:");
  try {
    const input = setup(db),
      f = new ExecutionFeedback(db);
    const unknown = f.recordWallet({ ...input, cashflow: undefined });
    assert.equal(unknown.status, "UNKNOWN");
    assert.equal(unknown.periodPnlMicros, null);
    const known = f.recordWallet({
      ...input,
      roundId: "r2",
      cashflow: {
        complete: true,
        netExternalFlowMicros: "0",
        hasExternalFlows: false,
        provenance: ["adapter:verified-no-external-flow"],
      },
    });
    assert.deepEqual(known.periodReturn, {
      numerator: "300000",
      denominator: "1000000",
    });
    assert.throws(() =>
      f.recordWallet({
        ...input,
        roundId: "bad",
        cashflow: { ...input.cashflow, provenance: [] },
      }),
    );
    db.put("portfolio-capture", "capture3", {
      status: "FAILED",
      snapshotId: input.closingSnapshotId,
    });
    const incomplete = f.recordWallet({ ...input, roundId: "r3" });
    assert.equal(incomplete.periodPnlMicros, null);
    assert(incomplete.missingReasons.includes("CLOSING_CAPTURE_INCOMPLETE"));
  } finally {
    db.close();
  }
});
test("network missing member remains UNKNOWN and summary retains durable references", () => {
  const db = new Store(":memory:");
  try {
    const input = setup(db),
      f = new ExecutionFeedback(db),
      row = f.recordWallet(input);
    const net = f.recordNetwork({
      roundId: "r",
      chainId: 56,
      memberObservationIds: [row.id],
      expectedWallets: [wallet, "0x0000000000000000000000000000000000000002"],
    });
    assert.equal(net.status, "UNKNOWN");
    assert.equal(net.periodPnlMicros, null);
    assert.equal(net.knownPeriodPnlMicros, "100000");
    const summary = buildExecutionFeedbackSummary(db, {
      roundId: "r",
      chainId: 56,
    });
    assert.equal(summary.network?.status, "UNKNOWN");
    assert.equal(summary.wallets[0]!.observationId, row.id);
    assert.equal(summary.wallets[0]!.jobId, "j");
    assert.deepEqual(summary.wallets[0]!.fillIds, input.fillIds);
    assert.throws(() =>
      f.recordNetwork({
        roundId: "r",
        chainId: 56,
        memberObservationIds: [row.id, row.id],
        expectedWallets: [wallet],
      }),
    );
  } finally {
    db.close();
  }
});
test("rejects wrong-wallet fills and snapshots outside execution interval", () => {
  const db = new Store(":memory:");
  try {
    const input = setup(db),
      f = new ExecutionFeedback(db),
      fill = db.get<any>("dex-v2-fill", input.fillIds[0]!)!;
    db.put("dex-v2-fill", fill.id, {
      ...fill,
      wallet: "0x0000000000000000000000000000000000000002",
    });
    assert.throws(() => f.recordWallet(input), /fill/i);
    db.put("dex-v2-fill", fill.id, { ...fill, block: 4 });
    assert.throws(() => f.recordWallet(input), /interval/i);
  } finally {
    db.close();
  }
});

test("restoring gas reserve uses full native valuation without truncation loss", () => {
  const db = new Store(":memory:");
  try {
    const input = setup(db);
    const old = db.get<any>("portfolio-snapshot", input.openingSnapshotId)!;
    const { id: _oldId, ...body } = old;
    body.navMicros = "0";
    body.holdings[0] = {
      ...body.holdings[0],
      balance: "2",
      gasExcluded: "1",
      valueMicros: "0",
      priceMicros: "500000000000000000",
    };
    const replacement = { ...body, id: hash(body) };
    db.insert("portfolio-snapshot", replacement.id, replacement);
    db.put("portfolio-capture", body.requestId, {
      status: "DONE",
      snapshotId: replacement.id,
    });
    const row = new ExecutionFeedback(db).recordWallet({
      ...input,
      openingSnapshotId: replacement.id,
    });
    assert.equal(row.openingNavMicros, "1");
  } finally {
    db.close();
  }
});

test("research summary bounds fill references while retaining full observation reference", () => {
  const db = new Store(":memory:");
  try {
    const input = setup(db);
    const source = db.get<any>("dex-v2-fill", input.fillIds[0]!)!;
    input.fillIds = [];
    for (let i = 1; i <= 40; i++) {
      const txHash = "0x" + String(i).padStart(64, "0");
      const id = hash(["dex-v2-fill/1", 56, txHash]);
      db.insert("dex-v2-fill", id, { ...source, id, hash: txHash });
      input.fillIds.push(id);
    }
    const row = new ExecutionFeedback(db).recordWallet(input);
    const summary = buildExecutionFeedbackSummary(db, {
      roundId: "r",
      chainId: 56,
    });
    assert.equal(row.fills.length, 40);
    assert.equal(summary.wallets[0]!.fillIds.length, 32);
    assert.equal(summary.wallets[0]!.omittedFillCount, 8);
    assert.equal(summary.wallets[0]!.observationId, row.id);
  } finally {
    db.close();
  }
});
