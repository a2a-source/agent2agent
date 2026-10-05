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
