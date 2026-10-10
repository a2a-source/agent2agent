import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { PortfolioCollector } from "../src/portfolio-snapshot.js";
import { ConfirmedStablePlans } from "../src/confirmed-stable-plans.js";
import { InvestmentPlanning } from "../src/investment-planning.js";
import { assets, stableFixture } from "./helpers/stable-qsp.js";
async function fixture(path = ":memory:") {
  const db = new Store(path),
    budget = new Budget(db),
    f = await stableFixture();
  let now = 1100,
    reads = 0,
    fail = false;
  const wallet = "0x" + "22".repeat(20),
    feed = "0x" + "33".repeat(20),
    stable = "0x" + "44".repeat(20);
  const registry = {
    chainId: 56,
    confirmations: 1,
    maxBlockAgeMs: 1000,
    maxPriceAgeMs: 1000,
    assets: [
      {
        asset: "native",
        bucket: "BNB",
        decimals: 18,
        feed,
        description: "BNB / USD",
      },
      ...assets.map((a, i) => ({
        asset: a.address,
        bucket: ["BTC", "ETH", "BNB"][i]!,
        decimals: a.decimals,
        feed,
        description: "test / USD",
      })),
      {
        asset: stable,
        bucket: "STABLE",
        decimals: 6,
        feed,
        description: "USD / USD",
      },
    ],
  };
  const collector = new PortfolioCollector(
    db,
    {
      chainId: async () => 56,
      tip: async () => 11,
      block: async (number) => ({
        number,
        hash: "0x" + "aa".repeat(32),
        timestamp: 1,
      }),
      read: async (a) => {
        reads++;
        if (fail) throw Error("offline");
        return {
          balance: a.bucket === "STABLE" ? "1000000000" : "0",
          decimals: a.decimals,
          price: {
            answer: "100000000",
            decimals: 8,
            description: a.description,
            roundId: "1",
            answeredInRound: "1",
            updatedAt: 1,
          },
        };
      },
    },
    registry,
    () => now,
  );
  db.put("epoch", "1", f.epoch);
  db.put("agent", "investor", {
    id: "investor",
    wallet,
    owner: "owner",
    launch: "CONFIRMED",
    jailed: false,
    autoStake: true,
  });
  db.put("chain-state", "investor", {
    known: true,
    observedAt: 1000,
    bonded: "300000000000000000",
    exit: "0",
    block: 10,
    hash: "0x" + "aa".repeat(32),
    balance: "0",
  });
  budget.credit("investor", "fund", 100n);
  const consumer = new ConfirmedStablePlans(db, budget, 56, 1000, () => 1n);
  const config = {
    maxAttempts: 3,
    retryMs: 10,
    leaseMs: 100,
    maxJobsPerTick: 2,
    gasReserveWei: "0",
  };
  const create = () =>
    new InvestmentPlanning(db, collector, consumer, config, () => now);
  return {
    db,
    budget,
    collector,
    consumer,
    create,
    config,
    setNow: (n: number) => (now = n),
    setFail: (b: boolean) => (fail = b),
    reads: () => reads,
  };
}
test("automatic planning captures and consumes once without per-wallet opt-in", async () => {
  const x = await fixture();
  try {
    await x.create().tick();
    assert.equal(x.db.all<any>("investment-planning-job")[0].status, "DONE");
    assert.equal(x.db.all("stable-wallet-plan").length, 1);
    const reads = x.reads();
    await x.create().tick();
    assert.equal(x.reads(), reads);
    assert.equal(x.db.all("investment-planning-attempt").length, 1);
  } finally {
    x.db.close();
  }
});
test("failed reads back off, survive service restart and retry with a new capture identity", async () => {
  const x = await fixture();
  try {
    x.setFail(true);
    await x.create().tick();
    assert.equal(x.db.all<any>("investment-planning-job")[0].status, "RETRY");
    const reads = x.reads();
    await x.create().tick();
    assert.equal(x.reads(), reads);
    x.setFail(false);
    x.setNow(1111);
    await x.create().tick();
    assert.equal(x.db.all<any>("investment-planning-job")[0].status, "DONE");
    assert.equal(x.db.all("portfolio-capture").length, 2);
  } finally {
    x.db.close();
  }
});
test("qualification refusal avoids RPC; expiry and max attempts close jobs", async () => {
  const x = await fixture();
  try {
    x.budget.setChainSync("investor", true);
    await x.create().tick();
    assert.equal(x.reads(), 0);
    x.setNow(1111);
    await x.create().tick();
    x.setNow(1132);
    await x.create().tick();
    assert.equal(x.db.all<any>("investment-planning-job")[0].status, "FAILED");
  } finally {
    x.db.close();
  }
  const y = await fixture();
  try {
    y.setFail(true);
    await y.create().tick();
    y.setNow(1500);
    await y.create().tick();
    assert.equal(y.db.all<any>("investment-planning-job")[0].status, "EXPIRED");
  } finally {
    y.db.close();
  }
});
test("restart recovers a committed consumption before job acknowledgement without another RPC", async () => {
  const x = await fixture();
  try {
    await x.create().tick();
    const job = x.db.entries<any>("investment-planning-job")[0]!;
    x.db.put("investment-planning-job", job.id, {
      ...job.data,
      status: "RUNNING",
      leaseUntil: 1101,
    });
    const reads = x.reads();
    x.setNow(1110);
    await x.create().tick();
    assert.equal(x.db.all<any>("investment-planning-job")[0].status, "DONE");
    assert.equal(x.reads(), reads);
    assert.equal(x.db.all("stable-wallet-plan").length, 1);
  } finally {
    x.db.close();
  }
});
test("expired lease cannot consume after another service takes over", async () => {
  const x = await fixture();
  const original = x.collector.collect.bind(x.collector);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let first = true;
  x.collector.collect = async (request) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return original(request);
  };
  try {
    const old = x.create().tick();
    await started;
    x.setNow(1201);
    await x.create().tick();
    release();
    await old;
    assert.equal(x.db.all("stable-wallet-plan").length, 1);
    assert.equal(x.db.all("stable-qsp-consumption").length, 1);
    const attempts = x.db.all<any>("investment-planning-attempt");
    assert.deepEqual(attempts.map((a) => a.status).sort(), ["DONE", "UNKNOWN"]);
  } finally {
    release();
    x.db.close();
  }
});
test("expired in-flight job closes its attempt audit", async () => {
  const x = await fixture();
  try {
    await x.create().tick();
    const job = x.db.all<any>("investment-planning-job")[0];
    const attempt = x.db.all<any>("investment-planning-attempt")[0];
    x.db.put("investment-planning-job", job.id, {
      ...job,
      status: "RUNNING",
      leaseUntil: 1200,
    });
    x.db.put("investment-planning-attempt", attempt.id, {
      ...attempt,
      status: "RUNNING",
      snapshotId: undefined,
    });
    x.setNow(1500);
    await x.create().tick();
    assert.equal(
      x.db.get<any>("investment-planning-job", job.id).status,
      "EXPIRED",
    );
    assert.equal(
      x.db.get<any>("investment-planning-attempt", attempt.id).status,
      "UNKNOWN",
    );
  } finally {
    x.db.close();
  }
});
test("pending wallet transaction prevents capture", async () => {
  const x = await fixture();
  try {
    x.db.put("transaction", "pending", {
      id: "pending",
      sender: "0x" + "22".repeat(20),
      state: "READY",
    });
    await x.create().tick();
    assert.equal(x.reads(), 0);
    assert.equal(
      x.db.all<any>("investment-planning-job")[0].reason,
      "WALLET_BUSY",
    );
  } finally {
    x.db.close();
  }
});

test("completed plan remains idempotent after SQLite closes and reopens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qsp-planning-"));
  const path = join(dir, "state.db");
  try {
    const first = await fixture(path);
    await first.create().tick();
    first.db.close();
    const next = await fixture(path);
    try {
      await next.create().tick();
      assert.equal(next.reads(), 0);
      assert.equal(next.db.all("stable-wallet-plan").length, 1);
      assert.equal(next.db.all("investment-planning-attempt").length, 1);
    } finally {
      next.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hung collector cannot retain the planning coordinator forever", async () => {
  const x = await fixture();
  const original = x.collector.collect.bind(x.collector);
  try {
    x.collector.collect = () => new Promise(() => {});
    const service = x.create();
    await service.tick();
    x.collector.collect = original;
    x.setNow(1201);
    await service.tick();
    assert.equal(x.db.all<any>("investment-planning-job")[0].status, "DONE");
  } finally {
    x.db.close();
  }
});
test("a persisted blocked outcome is terminal and keeps its plan association", async () => {
  const x = await fixture();
  try {
    const original = x.consumer.consume.bind(x.consumer);
    x.consumer.consume = (...args) => {
      const result = original(...args);
      return {
        ...result,
        status: "REJECTED",
        reason: "BLOCKED_REFERENCE_PLAN",
      };
    };
    await x.create().tick();
    const job = x.db.all<any>("investment-planning-job")[0];
    assert.equal(job.status, "DONE");
    assert.ok(job.planId);
    assert.equal(job.reason, "BLOCKED_REFERENCE_PLAN");
    const reads = x.reads();
    x.setNow(1111);
    await x.create().tick();
    assert.equal(x.reads(), reads);
  } finally {
    x.db.close();
  }
});
