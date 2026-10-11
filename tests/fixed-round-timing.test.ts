import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Epochs } from "../src/epochs.js";
import { ResearchTasks } from "../src/tasks.js";
import { Scheduler } from "../src/scheduler.js";
const timing = {
  version: "fixed-start/1" as const,
  intervalMs: 300000,
  maxDurationMs: 300000,
  viewTimeoutMs: 240000,
  confirmationReserveMs: 15000,
};
const config = {
  termSlots: 7,
  committeeSize: 3,
  timeoutMs: 1800000,
  epochMs: 300000,
};
const candidates = Array.from({ length: 3 }, (_, i) => ({
  id: `a${i}`,
  wallet: `0x${String(i + 1).padStart(40, "0")}`,
  stake: "300000000000000000",
  compute: "100000",
}));
const flush = () => new Promise<void>((r) => setImmediate(r));
test("fixed timing preserves term hash and bounds every recovered view", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  try {
    const old = epochs.open(1791643428371, candidates, config, 0);
    db.put("epoch", old.id, { ...old, status: "FAILED" });
    const e = epochs.open(old.slot + 1, candidates, config, 1000, timing, 1000);
    assert.equal(e.roundDeadline, 301000);
    assert.equal(e.researchDeadline, 286000);
    assert.equal(e.deadline, 241000);
    assert.equal(e.configHash, old.configHash);
    assert.deepEqual(e.committee, old.committee);
    const next = epochs.takeover(e.id, 0, 241000);
    assert.equal(next.roundDeadline, 301000);
    assert.equal(next.deadline, 286000);
    assert.equal(epochs.takeover(e.id, 1, 286000).status, "FAILED");
  } finally {
    db.close();
  }
});
test("required exhaustion notifies immediately, cancels siblings, and drains before returning", async () => {
  const db = new Store(":memory:");
  let release!: () => void,
    notified = false,
    settled = false;
  const gate = new Promise<void>((r) => (release = r));
  const tasks = new ResearchTasks(db, {
    epoch: "0",
    view: 0,
    concurrency: 6,
    maxAttempts: 2,
    onFailure: () => {
      assert.equal(db.get<any>("research-task", "bad")?.status, "FAILED");
      notified = true;
    },
  });
  const result = tasks
    .map([0, 1, 2, 3, 4, 5], async (i) =>
      tasks.execute(
        i === 0 ? "bad" : `good${i}`,
        ["a"],
        Date.now() + 60000,
        () => {
          if (notified) throw Error("cancelled");
        },
        async () => {
          if (i === 0) throw new SyntaxError("invalid");
          await gate;
          return i;
        },
      ),
    )
    .finally(() => (settled = true));
  const rejected = assert.rejects(result);
  await flush();
  assert.equal(notified, true);
  assert.equal(settled, false);
  release();
  await rejected;
  assert.equal(
    db.all<any>("research-attempt").filter((a) => a.status === "DONE").length,
    0,
  );
  assert.equal(
    db
      .all<any>("research-attempt")
      .filter((a) => a.failure === "INVALID_OUTPUT").length,
    2,
  );
  db.close();
});
test("blocked housekeeping cannot hold round expiry or accumulate calls", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  const e = epochs.open(0, candidates, config, 1000, timing, 1000);
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((r) => (release = r));
  const runner: any = {
    agents: { db, list: () => [] },
    config: { roundTiming: timing, network: config },
    epochs,
    cancel() {},
    run: async () => {},
    candidates: () => [],
    llm: {
      refreshPrice: async () => {},
      priceReady: () => true,
      probeProvider: async () => false,
    },
  };
  const scheduler = new Scheduler(
    runner,
    { observeResearch() {}, recoverOperational: async () => {} } as any,
    {
      journal: { recover: async () => {} },
      tick: async () => {
        calls++;
        await gate;
      },
    } as any,
  );
  try {
    await scheduler.tick();
    await flush();
    t.mock.timers.setTime(301000);
    await scheduler.tick();
    await flush();
    assert.equal(epochs.get(e.id).status, "FAILED");
    assert.equal(
      db.get<any>("incident", `timeout:${e.id}:0`)?.reason,
      "ROUND_TIMEOUT",
    );
    assert.equal(calls, 1);
  } finally {
    release();
    await scheduler.stop();
    db.close();
  }
});

test("timed epoch reload fails closed if frozen deadline fields are missing or extended", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  try {
    const e = epochs.open(0, candidates, config, 1000, timing, 1000);
    for (const bad of [
      { ...e, roundDeadline: undefined },
      { ...e, roundDeadline: 601000 },
      { ...e, deadline: 301001 },
    ]) {
      db.put("epoch", e.id, bad);
      assert.throws(() => epochs.get(e.id), /round timing/);
    }
  } finally {
    db.close();
  }
});

test("failure recovery requires durable same-view proof and never treats pending as exhausted", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  try {
    const e = epochs.open(0, candidates, config, 1000, timing, 1000);
    db.put("research-task", "role", { epoch: e.id, view: 0, status: "ACTIVE" });
    assert.throws(() => epochs.recoverFailedView(e.id, 0, 11000), /proof/);
    db.put("research-task", "role", {
      epoch: e.id,
      view: 0,
      status: "FAILED",
      terminalReason: "INVALID_OUTPUT",
    });
    const recovered = epochs.recoverFailedView(e.id, 0, 11000);
    assert.equal(recovered.view, 1);
    assert.equal(recovered.roundDeadline, 301000);
    assert.throws(() => epochs.recoverFailedView(e.id, 0, 11001), /stale/);
  } finally {
    db.close();
  }
});

test("fixed scheduler starts at grid boundary after fast finish and skips jumps without bursts", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  let runs = 0;
  const runner: any = {
    agents: { db, list: () => [] },
    config: {
      roundTiming: timing,
      network: { ...config, stateMaxAgeMs: 600000 },
    },
    epochs,
    cancel() {},
    candidates: () => candidates,
    llm: {
      refreshPrice: async () => {},
      priceReady: () => true,
      probeProvider: async () => true,
    },
    run: async () => {
      runs++;
    },
  };
  let s = new Scheduler(runner, {
    observeResearch() {},
    recoverOperational: async () => {},
  } as any);
  try {
    await s.tick();
    await flush();
    assert.equal(runs, 1);
    t.mock.timers.setTime(31000);
    epochs.fail("0", 0, "FIXTURE", Date.now());
    await s.tick();
    await flush();
    assert.equal(db.all("epoch").length, 1);
    t.mock.timers.setTime(301000);
    await s.tick();
    await flush();
    assert.equal(db.all("epoch").length, 2);
    await s.stop();
    s = new Scheduler(runner, {
      observeResearch() {},
      recoverOperational: async () => {},
    } as any);
    await s.tick();
    await flush();
    assert.equal(db.all("epoch").length, 2);
    epochs.fail("1", 0, "FIXTURE", Date.now());
    t.mock.timers.setTime(1501000);
    await s.tick();
    await flush();
    assert.equal(db.all("epoch").length, 3);
    assert.equal(epochs.get("2").scheduledAt, 1501000);
    assert.equal(db.get<any>("schedule", "fixed-start/1").skippedSlots, 3);
  } finally {
    await s.stop();
    db.close();
  }
});

test("six independent role attempts start before completion without duplicated identities", async () => {
  const db = new Store(":memory:");
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((r) => (release = r));
  const tasks = new ResearchTasks(db, { concurrency: 6, maxAttempts: 2 });
  const result = tasks.map([0, 1, 2, 3, 4, 5], (i) =>
    tasks.execute(
      `role${i}`,
      ["worker"],
      Date.now() + 60000,
      () => {},
      async () => {
        calls++;
        await gate;
        return i;
      },
    ),
  );
  await flush();
  assert.equal(calls, 6);
  assert.equal(db.all("research-attempt").length, 6);
  release();
  assert.deepEqual(await result, [0, 1, 2, 3, 4, 5]);
  db.close();
});

for (const phase of ["launch", "maintenance", "oracle", "probe"] as const)
  test(`blocked ${phase} cannot extend timed confirmation and stop drains its single flight`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1000 });
    const db = new Store(":memory:"),
      epochs = new Epochs(db);
    const e = epochs.open(0, candidates, config, 1000, timing, 1000);
    db.put("confirmation-proposal", e.id, { fixture: true });
    let release!: () => void,
      calls = 0,
      runs = 0;
    const gate = new Promise<void>((r) => (release = r)),
      block = async () => {
        calls++;
        await gate;
      };
    const runner: any = {
      agents: {
        db,
        list: () =>
          phase === "launch" ? [{ id: "a", launch: "PENDING" }] : [],
      },
      config: { roundTiming: timing, network: config },
      epochs,
      cancel() {},
      candidates: () => [],
      run: async () => {
        runs++;
      },
      llm: {
        refreshPrice: phase === "oracle" ? block : async () => {},
        priceReady: () => true,
        probeProvider: phase === "probe" ? block : async () => false,
      },
    };
    const scheduler = new Scheduler(
      runner,
      { observeResearch() {}, recoverOperational: async () => {} } as any,
      undefined,
      phase === "launch"
        ? ({ journal: { enabled: true }, advance: block } as any)
        : undefined,
      phase === "maintenance" ? ({ tick: block } as any) : undefined,
    );
    try {
      await scheduler.tick();
      await flush();
      assert.ok(runs > 0);
      assert.equal(calls, 1);
      t.mock.timers.setTime(301000);
      await scheduler.tick();
      assert.equal(epochs.get(e.id).status, "FAILED");
      assert.equal(calls, 1);
      let stopped = false;
      const stopping = scheduler.stop().then(() => (stopped = true));
      await flush();
      assert.equal(stopped, false);
      const before = runs;
      await scheduler.tick();
      assert.equal(runs, before);
      release();
      await stopping;
      await scheduler.tick();
      assert.equal(calls, 1);
    } finally {
      release();
      await scheduler.stop();
      db.close();
    }
  });

test("scheduler fences an exhausted view immediately but starts its successor only after actual sibling drain", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  let release!: () => void,
    runs = 0,
    aborted = false;
  const gate = new Promise<void>((r) => (release = r));
  const runner: any = {
    agents: { db, list: () => [] },
    config: {
      roundTiming: timing,
      network: { ...config, stateMaxAgeMs: 600000 },
    },
    epochs,
    cancel() {
      aborted = true;
    },
    candidates: () => candidates,
    llm: {
      refreshPrice: async () => {},
      priceReady: () => true,
      probeProvider: async () => true,
    },
    run: async (e: any) => {
      runs++;
      if (e.view > 0) {
        epochs.fail(e.id, e.view, "FIXTURE");
        return;
      }
      const tasks = new ResearchTasks(db, {
        epoch: e.id,
        view: e.view,
        concurrency: 6,
        maxAttempts: 2,
        onFailure: () => {
          aborted = true;
        },
      });
      await tasks.map(["bad", "slow"], (role) =>
        tasks.execute(
          `${e.id}:${e.view}:report:${role}`,
          ["a"],
          e.deadline,
          () => {
            if (aborted || epochs.get(e.id).view !== e.view)
              throw Error("cancelled");
          },
          async () => {
            if (role === "bad") throw new SyntaxError("invalid");
            await gate;
            return "late";
          },
        ),
      );
    },
  };
  const s = new Scheduler(runner, {
    observeResearch() {},
    recoverOperational: async () => {},
  } as any);
  try {
    await s.tick();
    await flush();
    assert.equal(aborted, true);
    assert.equal(runs, 1);
    t.mock.timers.setTime(11000);
    await s.tick();
    assert.equal(epochs.get("0").view, 1);
    assert.equal(runs, 1);
    release();
    await flush();
    await s.tick();
    await flush();
    assert.equal(runs, 2);
    assert.equal(
      db.all<any>("research-attempt").filter((a) => a.status === "DONE").length,
      0,
    );
  } finally {
    release();
    await s.stop();
    db.close();
  }
});

test("legacy SQLite migration ignores the old terminal wait, preserves term evidence and reopens frozen timing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2000000 });
  const dir = mkdtempSync(join(tmpdir(), "a2a-fixed-")),
    path = join(dir, "db.sqlite");
  let db = new Store(path),
    epochs = new Epochs(db);
  const migrationConfig = { ...config, termSlots: 100, stateMaxAgeMs: 600000 };
  const old = epochs.open(1791643428371, candidates, migrationConfig, 1000);
  const terminal = {
    ...old,
    status: "PUBLISHED",
    finishedAt: 2000,
    nextEligibleAt: 302000,
    output: { historical: true },
    signature: "historical-bytes",
    confirmation: { historical: "certificate" },
  };
  db.put("epoch", old.id, terminal);
  db.put("schedule", "network", {
    version: "end-relative/1",
    nextAt: 999999999,
  });
  const terms = db.all("term"),
    elections = db.all("election");
  const make = () =>
    new Scheduler(
      {
        agents: { db, list: () => [] },
        config: {
          roundTiming: timing,
          network: migrationConfig,
        },
        epochs,
        cancel() {},
        candidates: () => candidates,
        llm: {
          refreshPrice: async () => {},
          priceReady: () => true,
          probeProvider: async () => true,
        },
        run: async () => {},
      } as any,
      { observeResearch() {}, recoverOperational: async () => {} } as any,
    );
  let s = make();
  try {
    await s.tick();
    await flush();
    const e = epochs.get(String(old.slot + 1));
    assert.equal(e.scheduledAt, 2000000);
    assert.equal(e.roundDeadline, 2300000);
    assert.equal(e.configHash, old.configHash);
    await s.stop();
    db.close();
    db = new Store(path);
    epochs = new Epochs(db);
    s = make();
    await s.tick();
    await flush();
    assert.deepEqual(epochs.get(e.id), e);
    assert.deepEqual(db.get("epoch", old.id), terminal);
    assert.deepEqual(db.all("term"), terms);
    assert.deepEqual(db.all("election"), elections);
    assert.equal(db.all("epoch").length, 2);
  } finally {
    await s.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deadline callback terminalizes a still-draining round without admitting an overlapping epoch", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  let release!: () => void,
    runs = 0;
  const gate = new Promise<void>((r) => (release = r));
  const runner: any = {
    agents: { db, list: () => [] },
    config: {
      roundTiming: timing,
      network: { ...config, stateMaxAgeMs: 600000 },
    },
    epochs,
    cancel() {},
    candidates: () => candidates,
    llm: {
      refreshPrice: async () => {},
      priceReady: () => true,
      probeProvider: async () => true,
    },
    run: async () => {
      runs++;
      await gate;
    },
  };
  const s = new Scheduler(runner, {
    observeResearch() {},
    recoverOperational: async () => {},
  } as any);
  try {
    await s.tick();
    await flush();
    assert.equal(runs, 1);
    t.mock.timers.tick(300000);
    assert.equal(epochs.get("0").status, "FAILED");
    assert.equal(epochs.get("0").finishedAt, 301000);
    assert.equal(runs, 1);
    assert.equal(db.all("epoch").length, 1);
  } finally {
    release();
    await s.stop();
    db.close();
  }
});
