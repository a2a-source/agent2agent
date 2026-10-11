import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Epochs } from "../src/epochs.js";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";
import { loadConfig } from "./test-config.js";
const candidates = Array.from({ length: 3 }, (_, i) => ({
  id: `a${i}`,
  wallet: `0x${String(i + 1).padStart(40, "0")}`,
  stake: "300000000000000000",
  compute: "100000",
}));
const config = {
  termSlots: 7,
  committeeSize: 7,
  timeoutMs: 60000,
  epochMs: 300000,
};
function legacyPublish(epochs: Epochs, id: string, now: number) {
  const e = epochs.get(id);
  delete e.confirmationRequired;
  epochs.db.put("epoch", id, e);
  epochs.publish(id, e.view, e.master, { signals: [] }, "legacy-fixture", now);
}
function scheduler(db: Store, epochs: Epochs, runs: string[]) {
  const cfg = loadConfig();
  cfg.network = { ...cfg.network, ...config };
  const runner: any = {
    agents: { db, list: () => [] },
    epochs,
    config: cfg,
    candidates: () => candidates,
    llm: {
      refreshPrice: async () => {},
      priceReady: () => true,
      probeProvider: async () => true,
    },
    cancel() {},
    async run(e: any) {
      runs.push(e.id);
    },
  };
  return new Scheduler(runner, {
    observeResearch() {},
    async recoverOperational() {},
  } as any);
}
test("terminal transactions persist a five-minute gate after publication or final failure", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  try {
    const e = epochs.open(0, candidates, config, 1000);
    legacyPublish(epochs, e.id, 11000);
    const p = epochs.get(e.id);
    assert.equal(p.finishedAt, 11000);
    assert.equal(p.nextEligibleAt, 311000);
    assert.equal(p.roundIntervalMs, 300000);
    const second = epochs.open(1, candidates, config, 311000);
    let active = second;
    while (active.status === "RUNNING")
      active = epochs.takeover(active.id, active.view, active.deadline);
    assert.equal(active.finishedAt, 491000);
    assert.equal(active.nextEligibleAt, 791000);
  } finally {
    db.close();
  }
});
test("long rounds wait 300000ms from completion and never overlap or catch up", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const db = new Store(":memory:"),
    epochs = new Epochs(db),
    runs: string[] = [];
  let s = scheduler(db, epochs, runs);
  try {
    s.runner.config.network.timeoutMs = 3600000;
    const e = epochs.open(0, candidates, s.runner.config.network, Date.now());
    db.put("schedule", "network", { nextAt: 301000 }); // Obsolete start-relative timer.
    t.mock.timers.setTime(901000);
    legacyPublish(epochs, e.id, Date.now());
    await s.tick();
    assert.equal(runs.length, 0);
    t.mock.timers.setTime(1200999);
    await s.tick();
    assert.equal(runs.length, 0);
    // A new Scheduler must preserve exactly the same terminal gate.
    await s.stop();
    s = scheduler(db, epochs, runs);
    // Preserve frozen term config apart from the independently updated interval.
    s.runner.config.network.timeoutMs = 3600000;
    t.mock.timers.setTime(1201000);
    await s.tick();
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(runs, ["1"]);
    t.mock.timers.setTime(1201001);
    await s.tick();
    assert.equal(
      db.all<any>("epoch").filter((e) => e.status === "RUNNING").length,
      1,
    );
  } finally {
    await s.stop();
    db.close();
    t.mock.timers.reset();
  }
});
test("historical terminal gate is observed once and survives SQLite reopen", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  const dir = mkdtempSync(join(tmpdir(), "a2a-cadence-")),
    path = join(dir, "db.sqlite");
  let db = new Store(path),
    epochs = new Epochs(db),
    runs: string[] = [],
    s = scheduler(db, epochs, runs);
  try {
    const e = epochs.open(0, candidates, s.runner.config.network, 1000);
    const historical: any = { ...e, status: "FAILED" };
    delete historical.roundIntervalMs;
    db.put("epoch", e.id, historical);
    db.put("schedule", "network", { nextAt: 1 });
    await s.tick();
    assert.equal(runs.length, 0);
    const saved = db.get<any>("schedule", "network");
    assert.equal(saved.nextAt, 1300000);
    assert.equal(saved.afterEpoch, e.id);
    await s.stop();
    db.close();
    db = new Store(path);
    epochs = new Epochs(db);
    s = scheduler(db, epochs, runs);
    t.mock.timers.setTime(1299999);
    await s.tick();
    assert.equal(runs.length, 0);
    t.mock.timers.setTime(2000000);
    await s.tick();
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(runs, ["1"]);
    assert.equal(db.all("epoch").length, 2);
  } finally {
    await s.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    t.mock.timers.reset();
  }
});
test("interval-only upgrade preserves existing term config and does not recalculate committee", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  try {
    const e = epochs.open(0, candidates, { ...config, epochMs: 900000 }, 1000);
    legacyPublish(epochs, e.id, 2000);
    const next = epochs.open(1, [...candidates].reverse(), config, 902000);
    assert.equal(next.configHash, e.configHash);
    assert.deepEqual(next.committee, e.committee);
    assert.equal(next.roundIntervalMs, 300000);
  } finally {
    db.close();
  }
});

test("scheduler waits after final failure but not between coordinator takeovers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const db = new Store(":memory:"),
    epochs = new Epochs(db),
    runs: string[] = [];
  const s = scheduler(db, epochs, runs);
  s.runner.config.network.timeoutMs = 10;
  try {
    const e = epochs.open(0, candidates, s.runner.config.network, 1000);
    for (const now of [1010, 1020, 1030]) {
      t.mock.timers.setTime(now);
      await s.tick();
      await new Promise<void>((r) => setImmediate(r));
    }
    assert.equal(epochs.get(e.id).status, "FAILED");
    assert.equal(epochs.get(e.id).finishedAt, 1030);
    assert.deepEqual(runs, ["0", "0"]);
    t.mock.timers.setTime(301029);
    await s.tick();
    assert.equal(db.all("epoch").length, 1);
    t.mock.timers.setTime(301030);
    await s.tick();
    await new Promise<void>((r) => setImmediate(r));
    assert.deepEqual(runs, ["0", "0", "1"]);
  } finally {
    await s.stop();
    db.close();
    t.mock.timers.reset();
  }
});
