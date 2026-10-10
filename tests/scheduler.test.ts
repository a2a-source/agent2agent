import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";
test("shutdown drains an in-flight chain poll and does not start another epoch", async () => {
  const db = new Store(":memory:");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let polls = 0;
  const runner: any = {
    agents: { db },
    cancel() {},
    candidates() {
      throw Error("must not schedule during shutdown");
    },
  };
  const watcher: any = {
    confirmations: 1,
    journal: { async recover() {} },
    async tick() {
      polls++;
      await gate;
      db.put("test", "drained", true);
    },
  };
  const scheduler = new Scheduler(runner, {} as any, watcher);
  const tick = scheduler.tick();
  await new Promise<void>((r) => setImmediate(r));
  let stopped = false;
  const stop = scheduler.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(stopped, false);
  release();
  await Promise.all([tick, stop]);
  assert.equal(db.get("test", "drained"), true);
  await scheduler.tick();
  assert.equal(polls, 1);
  db.close();
});

test("settlement errors are isolated from provider health and research scheduling", async () => {
  const db = new Store(":memory:");
  let probed = false;
  const runner: any = {
    agents: { db, list: () => [] },
    llm: {
      refreshPrice: async () => {},
      priceReady: () => true,
      probeProvider: async () => {
        probed = true;
        return false;
      },
    },
    cancel() {},
  };
  const penalties: any = {
    observeResearch() {},
    async recoverOperational() {},
  };
  const settlement: any = {
    async tick() {
      throw Error("temporary settlement failure");
    },
  };
  await new Scheduler(
    runner,
    penalties,
    undefined,
    undefined,
    undefined,
    settlement,
  ).tick();
  assert.equal(probed, true);
  assert.equal(
    db.get<any>("service-error", "settlement").reason,
    "SETTLEMENT_RETRY_PENDING",
  );
  db.close();
});

test("accounting persists before unhealthy provider gates and retries independently", async () => {
  const db = new Store(":memory:");
  let captures = 0;
  const runner: any = {
    agents: { db, list: () => [] },
    llm: {
      refreshPrice: async () => {},
      priceReady: () => false,
      probeProvider: async () => false,
    },
  };
  const penalties: any = {
    observeResearch() {},
    recoverOperational: async () => {},
  };
  const accounting = {
    tick() {
      captures++;
      if (captures === 1) throw Error("busy");
      db.put("test", "accounted", true);
    },
  };
  const s = new Scheduler(
    runner,
    penalties,
    undefined,
    undefined,
    undefined,
    undefined,
    accounting,
  );
  try {
    await s.tick();
    assert.equal(
      db.get<any>("service-error", "performance-accounting").reason,
      "ACCOUNTING_RETRY_PENDING",
    );
    await s.tick();
    assert.equal(captures, 2);
    assert.equal(db.get("test", "accounted"), true);
  } finally {
    db.close();
  }
});

test("shutdown waits for post-round accounting to finish", async () => {
  const db = new Store(":memory:");
  let release!: () => void;
  let captured = false;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const epoch = {
    id: "1",
    slot: 1,
    status: "RUNNING",
    deadline: Date.now() + 60000,
  };
  db.put("epoch", "1", epoch);
  const runner: any = {
    agents: { db, list: () => [] },
    llm: {
      refreshPrice: async () => {},
      priceReady: () => true,
      probeProvider: async () => true,
    },
    cancel() {},
    run: async () => {
      db.put("epoch", "1", { ...epoch, status: "PUBLISHED" });
    },
  };
  const accounting = {
    async tick() {
      if (db.get<any>("epoch", "1").status === "PUBLISHED") {
        await gate;
        captured = true;
      }
    },
  };
  const s = new Scheduler(
    runner,
    { observeResearch() {}, recoverOperational: async () => {} } as any,
    undefined,
    undefined,
    undefined,
    undefined,
    accounting,
  );
  try {
    await s.tick();
    await new Promise((r) => setImmediate(r));
    let stopped = false;
    const stop = s.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(stopped, false);
    release();
    await stop;
    assert.equal(captured, true);
  } finally {
    release();
    db.close();
  }
});
