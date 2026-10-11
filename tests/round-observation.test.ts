import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { hash } from "../src/protocol.js";
import {
  freezeTerminalObservationRoster,
  publishRoundObservation,
} from "../src/round-observation.js";
import { PerformanceLedger } from "../src/performance-ledger.js";
const wallet = "0x" + "11".repeat(20);
export function emptyObservation() {
  return {
    chainId: 97,
    roundId: "1",
    sourceStatus: "FAILED" as const,
    terminalAt: 1000,
    observedAt: 2000,
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
test("observation publication is atomic, immutable, currency isolated and CAS guarded", () => {
  const db = new Store(":memory:");
  try {
    const input = emptyObservation(),
      first = publishRoundObservation(db, input, null);
    assert.deepEqual(publishRoundObservation(db, input, null), first);
    assert.equal(
      new PerformanceLedger(db).latest("1", 97, "micro-USD")?.network.periodPnL,
      null,
    );
    assert.equal(new PerformanceLedger(db).latest("1", 97), undefined);
    assert.throws(
      () => publishRoundObservation(db, { ...input, observedAt: 3000 }, null),
      /CONFLICT/,
    );
    const final = publishRoundObservation(
      db,
      { ...input, lifecycle: "COMPLETE", observedAt: 3000 },
      first.id,
    );
    assert.equal(final.revision, 2);
    assert.equal(
      db.get<any>("round-observation", first.id)?.lifecycle,
      "PENDING",
    );
    assert.throws(
      () =>
        publishRoundObservation(
          db,
          {
            ...input,
            roundId: "forged",
            wallets: [
              { ...input.wallets[0]!, closingSnapshotId: "a".repeat(64) },
            ],
          },
          null,
        ),
      /SNAPSHOT/,
    );
  } finally {
    db.close();
  }
});
test("terminal roster freezes original identities without changing signed epoch", () => {
  const db = new Store(":memory:");
  try {
    db.put("agent", "a", { id: "a", wallet, createdAt: 0 });
    const e: any = {
      id: "1",
      status: "FAILED",
      finishedAt: 1000,
      output: { allocation: null },
      signature: "signature",
    };
    const before = hash(e);
    freezeTerminalObservationRoster(db, e);
    db.remove("agent", "a");
    freezeTerminalObservationRoster(db, e);
    assert.equal(hash(e), before);
    assert.equal(
      db.get<any>("round-observation-terminal", "1").roster[0].wallet,
      wallet,
    );
  } finally {
    db.close();
  }
});

test("terminal lifecycle publishes two revisions, resumes baseline and never creates authority", async () => {
  const { RoundObservationService } =
    await import("../src/round-observation.js");
  const { PortfolioCollector } = await import("../src/portfolio-snapshot.js");
  const db = new Store(":memory:");
  let now = 1000000,
    block = 10,
    price = "100000000";
  try {
    const wallet = "0x" + "11".repeat(20),
      assets = ["BNB", "BTC", "ETH", "STABLE"].map((bucket, i) => ({
        asset: i ? "0x" + String(i).repeat(40) : "native",
        bucket,
        decimals: i ? 6 : 18,
        feed: "0x" + "22".repeat(20),
        description: bucket + " / USD",
      }));
    const registry = {
      chainId: 97,
      confirmations: 2,
      maxBlockAgeMs: 60000,
      maxPriceAgeMs: 60000,
      assets,
    };
    const reader = {
      chainId: async () => 97,
      tip: async () => block + 2,
      block: async (n: number) => ({
        number: n,
        hash: "0x" + n.toString(16).padStart(64, "0"),
        timestamp: now / 1000 - 1,
      }),
      read: async (a: any) => ({
        balance: a.bucket === "STABLE" ? "100000000" : "0",
        decimals: a.decimals,
        price: {
          answer: price,
          decimals: 8,
          description: a.description,
          roundId: "1",
          answeredInRound: "1",
          updatedAt: now / 1000 - 2,
        },
      }),
    };
    const collector = new PortfolioCollector(db, reader, registry, () => now);
    const adapters = {
      collector,
      selectBoundary: async () => ({
        blockNumber: block,
        blockHash: "0x" + block.toString(16).padStart(64, "0"),
        blockTimeMs: now - 1000,
      }),
      settlementReady: () => true,
      prove: async (a: string, b: string) => {
        const { proveRoundNoExternalFlow } =
          await import("../src/round-cashflow.js");
        const provider: any = {
          send: async (_m: string, args: any[]) => ({
            number: args[0],
            hash: "0x" + Number(BigInt(args[0])).toString(16).padStart(64, "0"),
          }),
          getNetwork: async () => ({ chainId: 97n }),
          getBlockNumber: async () => block + 2,
          getCode: async () => "0x",
          getTransactionCount: async () => 0,
          getLogs: async () => [],
        };
        return proveRoundNoExternalFlow(db, provider, a, b, 2);
      },
    };
    const add = (id: string) => {
      const e: any = { id, status: "FAILED", finishedAt: now - 2000 };
      db.put("epoch", id, e);
      freezeTerminalObservationRoster(db, e);
    };
    db.put("agent", "a", { id: "a", wallet, createdAt: 0 });
    add("1");
    let service = new RoundObservationService(db, 97, adapters, {}, () => now);
    await service.tick();
    assert.equal(db.all<any>("round-observation").length, 2);
    assert.equal(
      new PerformanceLedger(db).latest("1", 97, "micro-USD")?.network.periodPnL,
      null,
    );
    now += 10000;
    block = 20;
    price = "110000000";
    add("2");
    service = new RoundObservationService(db, 97, adapters, {}, () => now);
    await service.tick();
    await service.tick();
    assert.equal(
      new PerformanceLedger(db).latest("2", 97, "micro-USD")?.network.periodPnL,
      "10000000",
    );
    assert.equal(db.all("round-observation").length, 4);
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

import { observationFixture } from "./helpers/round-observation-fixtures.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("failed partial captures persist across restart and exhaust exactly three attempts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observation-")),
    path = join(dir, "state.db");
  let db = new Store(path);
  try {
    let f = observationFixture(db);
    f.addAgent("a", 20);
    f.addEpoch("1");
    f.state.fail = true;
    await f.service().tick();
    assert.equal(f.job("1").walletWork.a.captureAttempts, 1);
    assert.equal(db.all("portfolio-snapshot").length, 0);
    assert.ok(
      db.all<any>("portfolio-observation").some((r) => r.status === "RETURNED"),
    );
    db.close();
    db = new Store(path);
    f = observationFixture(db);
    f.state.fail = true;
    f.state.now = 1030000;
    await f.service().tick();
    f.state.now = 1060000;
    await f.service().tick();
    f.state.now = 1090000;
    await f.service().tick();
    assert.equal(f.job("1").status, "COMPLETE");
    assert.equal(f.job("1").walletWork.a.captureAttempts, 3);
    assert.equal(db.all("portfolio-capture").length, 3);
    assert.equal(
      db
        .all<any>("round-observation-attempt")
        .filter((a) => a.phase === "capture" && a.status === "FAILED").length,
      3,
    );
    assert.equal(db.all("round-observation").length, 2);
    await f.service().tick();
    assert.equal(db.all("round-observation").length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("lease generation fences an old asynchronous collector after takeover", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    f.addAgent("a", 20);
    f.addEpoch("1");
    const collect = f.collector.collectAt.bind(f.collector);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    f.collector.collectAt = async (...args) => {
      if (++calls === 1) await gate;
      return collect(...args);
    };
    const old = f.service().tick();
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(f.job("1").generation, 1);
    f.state.now += 120001;
    await f.service().tick();
    assert.equal(f.job("1").generation, 2);
    assert.equal(f.job("1").status, "COMPLETE");
    const head = f.job("1").headId;
    release();
    await old;
    assert.equal(f.job("1").headId, head);
    assert.equal(db.all("round-observation").length, 2);
  } finally {
    db.close();
  }
});
test("backlog older rounds never receive current holdings and missing predecessor cannot be skipped", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    f.addAgent("a", 20);
    f.addEpoch("old", false, 100);
    f.addEpoch("latest", true, 200);
    await f.service().tick();
    assert.equal(f.job("old").input.wallets[0].closingSnapshotId, null);
    assert.ok(
      f
        .job("old")
        .input.missingReasons.includes("HISTORIC_BOUNDARY_UNAVAILABLE"),
    );
    assert.ok(
      f.job("old").input.missingReasons.includes("ROSTER_HISTORY_INCOMPLETE"),
    );
    assert.equal(f.job("latest").input.wallets[0].openingSnapshotId, null);
    assert.ok(f.job("latest").input.wallets[0].closingSnapshotId);
  } finally {
    db.close();
  }
});
test("settlement polls do not consume capture or pin budgets and deadline completes UNKNOWN", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    f.addAgent("a", 20);
    f.addEpoch("1");
    f.state.wait = true;
    for (let i = 0; i < 5; i++) {
      await f.service().tick();
      f.state.now += 30000;
    }
    assert.equal(f.job("1").pinAttempts, 0);
    assert.equal(f.job("1").walletWork.a.captureAttempts, 0);
    f.state.now = 1600000;
    await f.service().tick();
    assert.equal(f.job("1").status, "COMPLETE");
    assert.ok(
      f
        .job("1")
        .input.missingReasons.includes("UNSETTLED_BOUNDARY_AT_DEADLINE"),
    );
    assert.ok(f.job("1").input.wallets[0].closingSnapshotId);
  } finally {
    db.close();
  }
});
test("foundation regression: self-hashed claimed KNOWN and false boundary time cannot publish", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    f.addAgent("a", 20);
    f.addEpoch("1");
    await f.service().tick();
    const j = f.job("1"),
      input = structuredClone(j.input);
    input.roundId = "bad-time";
    input.closingBoundary.blockTimeMs--;
    assert.throws(
      () => publishRoundObservation(db, input, null),
      /TIME_MISMATCH/,
    );
    input.roundId = "forged-proof";
    input.closingBoundary = j.input.closingBoundary;
    input.openingBoundary = input.closingBoundary;
    input.wallets[0].openingSnapshotId = input.wallets[0].closingSnapshotId;
    const body = {
      version: "round-cashflow-proof/1",
      scope: "REGISTERED_ASSETS_AND_NATIVE_EOA",
      openingSnapshotId: input.wallets[0].openingSnapshotId,
      closingSnapshotId: input.wallets[0].closingSnapshotId,
      status: "KNOWN",
      reasons: [],
    };
    const id = hash(body);
    db.put("round-cashflow-proof", id, { ...body, id });
    input.wallets[0].proofIds = [id];
    assert.throws(
      () => publishRoundObservation(db, input, null),
      /PROVENANCE_INVALID/,
    );
  } finally {
    db.close();
  }
});

test("DONE capture is reused after a crash before wallet state update", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    f.addAgent("a", 20);
    f.addEpoch("1");
    const collect = f.collector.collectAt.bind(f.collector);
    let calls = 0;
    f.collector.collectAt = async (...args) => {
      calls++;
      await collect(...args);
      throw Error("crash after durable capture");
    };
    await f.service().tick();
    assert.equal(f.job("1").status, "RETRY");
    f.state.now += 30000;
    await f.service().tick();
    assert.equal(f.job("1").status, "COMPLETE");
    assert.equal(calls, 1);
    assert.equal(f.job("1").walletWork.a.captureAttempts, 1);
    assert.ok(f.job("1").input.wallets[0].closingSnapshotId);
  } finally {
    db.close();
  }
});
test("proof transport retries exhaust separately while retaining closing holdings and proof identities", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    f.addAgent("a", 20);
    f.addEpoch("1");
    await f.service().tick();
    f.state.now += 10000;
    f.state.block = 20;
    f.addEpoch("2");
    f.provider.getLogs = async () => {
      throw Error("offline");
    };
    for (let i = 0; i < 4; i++) {
      await f.service().tick();
      f.state.now += 30000;
    }
    const j = f.job("2");
    assert.equal(j.status, "COMPLETE");
    assert.equal(j.walletWork.a.captureAttempts, 1);
    assert.equal(j.walletWork.a.proofAttempts, 3);
    assert.ok(j.input.wallets[0].closingSnapshotId);
    assert.ok(j.input.wallets[0].proofIds.length);
    assert.equal(
      new PerformanceLedger(db).latest("2", 97, "micro-USD")?.network.periodPnL,
      null,
    );
  } finally {
    db.close();
  }
});
test("a joined wallet resets only its own baseline and prevents a complete network total", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    f.addAgent("a", 20);
    f.addAgent("b", 21);
    f.addEpoch("1");
    await f.service().tick();
    f.state.now += 10000;
    f.state.block = 20;
    f.state.price = "110000000";
    f.addAgent("c", 22);
    f.addEpoch("2");
    await f.service().tick();
    const r = new PerformanceLedger(db).latest("2", 97, "micro-USD")!;
    assert.equal(r.network.periodPnL, null);
    assert.equal(r.network.knownPeriodPnL, "20000000");
    assert.equal(r.network.missingAgentCount, 1);
    assert.equal(r.agents.find((a) => a.agentId === "c")?.periodPnL, null);
  } finally {
    db.close();
  }
});

test("expired pin owners cannot capture or publish without a fresh lease claim", async () => {
  for (const elapsed of [121000, 700000]) {
    const db = new Store(":memory:");
    try {
      const f = observationFixture(db);
      f.addAgent("a", 20);
      f.addEpoch("1");
      const pin = f.adapters.selectBoundary;
      f.adapters.selectBoundary = async () => {
        await Promise.resolve();
        f.state.now += elapsed;
        return pin();
      };
      await f.service().tick();
      assert.equal(f.job("1").status, "RUNNING");
      assert.equal(f.job("1").walletWork.a.captureAttempts, 0);
      assert.equal(f.job("1").input.closingBoundary, null);
      assert.equal(db.all("round-observation").length, 1);
      f.adapters.selectBoundary = pin;
      await f.service().tick();
      assert.equal(f.job("1").generation, 2);
      assert.equal(f.job("1").status, "COMPLETE");
      if (elapsed === 700000) {
        assert.equal(f.job("1").walletWork.a.captureAttempts, 0);
        assert.ok(
          f
            .job("1")
            .input.missingReasons.includes("OBSERVATION_DEADLINE_EXHAUSTED"),
        );
      }
    } finally {
      db.close();
    }
  }
});
test("ordinary deadline crossed during pin stops before capture even with a valid longer lease", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db, { leaseMs: 1000000 });
    f.addAgent("a", 20);
    f.addEpoch("1");
    const pin = f.adapters.selectBoundary;
    f.adapters.selectBoundary = async () => {
      await Promise.resolve();
      f.state.now += 700000;
      return pin();
    };
    await f.service().tick();
    assert.equal(f.job("1").status, "COMPLETE");
    assert.equal(f.job("1").walletWork.a.captureAttempts, 0);
    assert.equal(f.job("1").input.closingBoundary, null);
    assert.ok(
      f
        .job("1")
        .input.missingReasons.includes("OBSERVATION_DEADLINE_EXHAUSTED"),
    );
  } finally {
    db.close();
  }
});
test("capture and proof expiry retain durable evidence but cannot advance the expired generation", async () => {
  for (const phase of ["capture", "proof"]) {
    const db = new Store(":memory:");
    try {
      const f = observationFixture(db);
      f.addAgent("a", 20);
      f.addEpoch("1");
      await f.service().tick();
      f.state.now += 10000;
      f.state.block = 20;
      f.addEpoch("2");
      const capture = f.collector.collectAt.bind(f.collector),
        proof = f.adapters.prove;
      let proofCalls = 0;
      f.adapters.prove = async (...args) => {
        proofCalls++;
        const result = await proof(...args);
        if (phase === "proof") f.state.now += 121000;
        return result;
      };
      if (phase === "capture")
        f.collector.collectAt = async (...args) => {
          const result = await capture(...args);
          f.state.now += 121000;
          return result;
        };
      await f.service().tick();
      const j = f.job("2");
      assert.equal(j.status, "RUNNING");
      assert.equal(db.all("round-observation").length, 3);
      assert.equal(j.walletWork.a.captureAttempts, 1);
      assert.equal(j.walletWork.a.done, false);
      assert.equal(j.input.wallets[0].proofIds.length, 0);
      assert.equal(
        db.all<any>("portfolio-capture").filter((c) => c.status === "DONE")
          .length,
        2,
      );
      assert.equal(proofCalls, phase === "capture" ? 0 : 1);
      f.collector.collectAt = capture;
      f.adapters.prove = proof;
      await f.service().tick();
      assert.equal(f.job("2").generation, 2);
      assert.equal(f.job("2").status, "COMPLETE");
      assert.equal(f.job("2").walletWork.a.captureAttempts, 1);
      assert.equal(
        new PerformanceLedger(db).latest("2", 97, "micro-USD")?.network
          .periodPnL,
        "0",
      );
    } finally {
      db.close();
    }
  }
});
test("ordinary deadline crossed during capture or proof never continues into KNOWN publication", async () => {
  for (const phase of ["capture", "proof"]) {
    const db = new Store(":memory:");
    try {
      const f = observationFixture(db, { leaseMs: 1000000 });
      f.addAgent("a", 20);
      f.addEpoch("1");
      await f.service().tick();
      f.state.now += 10000;
      f.state.block = 20;
      f.addEpoch("2");
      const capture = f.collector.collectAt.bind(f.collector),
        prove = f.adapters.prove;
      let proofCalls = 0;
      f.adapters.prove = async (...args) => {
        proofCalls++;
        const result = await prove(...args);
        if (phase === "proof") f.state.now += 700000;
        return result;
      };
      if (phase === "capture")
        f.collector.collectAt = async (...args) => {
          const result = await capture(...args);
          f.state.now += 700000;
          return result;
        };
      await f.service().tick();
      assert.equal(f.job("2").status, "COMPLETE");
      assert.equal(f.job("2").input.wallets[0].proofIds.length, 0);
      assert.ok(
        f
          .job("2")
          .input.missingReasons.includes("OBSERVATION_DEADLINE_EXHAUSTED"),
      );
      assert.equal(proofCalls, phase === "capture" ? 0 : 1);
      assert.equal(
        db.all<any>("portfolio-capture").filter((c) => c.status === "DONE")
          .length,
        2,
      );
      assert.equal(
        new PerformanceLedger(db).latest("2", 97, "micro-USD")?.network
          .periodPnL,
        null,
      );
    } finally {
      db.close();
    }
  }
});
test("unsupported pin outcomes close attempts with a terminal reason", async () => {
  for (const kind of ["null", "nonadvancing", "future", "malformed"]) {
    const db = new Store(":memory:");
    try {
      const f = observationFixture(db);
      f.addAgent("a", 20);
      f.addEpoch("1");
      await f.service().tick();
      f.state.now += 10000;
      f.addEpoch("2");
      const pin = f.adapters.selectBoundary;
      f.adapters.selectBoundary = (async () =>
        kind === "null"
          ? null
          : kind === "future"
            ? { ...(await pin()), blockTimeMs: f.state.now + 1000 }
            : kind === "malformed"
              ? { ...(await pin()), blockNumber: 20, blockHash: "bad" }
              : pin()) as typeof pin;
      await f.service().tick();
      const attempts = db
        .all<any>("round-observation-attempt")
        .filter((a) => a.jobId === f.job("2").id && a.phase === "pin");
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, "FAILED");
      assert.equal(
        attempts[0].reason,
        kind === "malformed" ? "INVALID_BOUNDARY" : "NON_ADVANCING_BOUNDARY",
      );
      assert.equal(attempts[0].finishedAt, f.state.now);
      assert.equal(f.job("2").status, "RETRY");
    } finally {
      db.close();
    }
  }
});

test("the settlement deadline opportunity remains lease-bound and cannot be renewed by a later generation", async () => {
  const db = new Store(":memory:");
  try {
    const f = observationFixture(db);
    f.addAgent("a", 20);
    f.addEpoch("1");
    f.state.wait = true;
    await f.service().tick();
    f.state.now = 1600000;
    const pin = f.adapters.selectBoundary;
    f.adapters.selectBoundary = async () => {
      const result = await pin();
      f.state.now += 121000;
      return result;
    };
    await f.service().tick();
    const j = f.job("1");
    assert.equal(j.status, "RUNNING");
    assert.equal(j.deadlinePinAttempted, true);
    assert.equal(j.deadlinePinGeneration, j.generation);
    assert.equal(j.walletWork.a.captureAttempts, 0);
    assert.equal(db.all("round-observation").length, 1);
    f.adapters.selectBoundary = pin;
    await f.service().tick();
    assert.equal(f.job("1").status, "COMPLETE");
    assert.equal(f.job("1").walletWork.a.captureAttempts, 0);
    assert.equal(f.job("1").pinAttempts, 1);
    assert.ok(
      f
        .job("1")
        .input.missingReasons.includes("OBSERVATION_DEADLINE_EXHAUSTED"),
    );
  } finally {
    db.close();
  }
});
