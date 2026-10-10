import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { ResearchTasks } from "../src/tasks.js";
import { Epochs } from "../src/epochs.js";
import { Penalties } from "../src/penalties.js";

function setup(limit = 3) {
  const db = new Store(":memory:");
  const agents: any = {
    db,
    get: (id: string) => db.get("agent", id),
    update: (id: string, change: any) =>
      db.put("agent", id, { ...db.get<any>("agent", id), ...change }),
  };
  for (const id of ["a", "b", "master"])
    db.put("agent", id, { id, jailed: false });
  db.put("epoch", "1", {
    id: "1",
    view: 0,
    status: "RUNNING",
    deadline: Date.now() + 60000,
  });
  return {
    db,
    agents,
    p: new Penalties(agents, new Epochs(db), 97, limit, 10000),
  };
}
function legacy(
  db: Store,
  key: string,
  agent = "a",
  status = "FAILED",
  finishedAt?: number,
) {
  db.put("research-attempt", key, {
    id: key,
    agent,
    status,
    failure: status === "FAILED" ? "INVALID_OUTPUT" : undefined,
    finishedAt,
  });
}
function closed(db: Store) {
  db.put("incident", "1:0:failure", {
    id: "1:0:failure",
    agent: "master",
    reason: "INVALID_OUTPUT",
    at: Date.now(),
  });
}

test("active invalid attempt and cross-agent DONE repair never jail; DONE is atomic", async () => {
  const { db, agents, p } = setup(1);
  const tasks = new ResearchTasks(db, {
    maxAttempts: 2,
    epoch: "1",
    view: 0,
  } as any);
  await tasks.execute(
    "1:0:report:news",
    ["a", "b"],
    Date.now() + 10000,
    () => {},
    async (agent) => {
      if (agent === "a") throw new SyntaxError("invalid JSON");
      p.observeResearch();
      assert.equal(agents.get("a").jailed, false);
      assert.equal(
        db.get<any>("research-task", "1:0:report:news").status,
        "ACTIVE",
      );
      return 42;
    },
  );
  p.observeResearch();
  assert.equal(agents.get("a").jailed, false);
  const task = db.get<any>("research-task", "1:0:report:news");
  assert.equal(task.status, "DONE");
  assert.equal(
    db.get<any>("research-attempt", task.resultAttemptId).status,
    "DONE",
  );
  assert.ok(task.finishedAt >= task.startedAt);
  db.close();
});

test("frozen exhausted task cannot gain retries and counts once per author per task", async () => {
  const { db, agents, p } = setup();
  for (let n = 0; n < 3; n++) {
    const key = `1:0:report:r${n}`;
    await assert.rejects(
      new ResearchTasks(db, { maxAttempts: 2 }).execute(
        key,
        ["a"],
        Date.now() + 10000,
        () => {},
        async () => {
          throw new SyntaxError("bad");
        },
      ),
    );
    await assert.rejects(
      new ResearchTasks(db, { maxAttempts: 8 }).execute(
        key,
        ["a"],
        Date.now() + 20000,
        () => {},
        async () => 42,
      ),
    );
    assert.equal(db.get<any>("research-task", key).maxAttempts, 2);
    p.observeResearch();
    assert.equal(agents.get("a").jailed, n === 2);
  }
  const before = db.get<any>("quarantine", "a").until;
  p.observeResearch(Date.now() + 1000);
  assert.equal(db.get<any>("quarantine", "a").until, before);
  db.close();
});

for (const last of ["worker ineligible", "provider timeout"])
  test(`mixed invalid then ${last} attributes only invalid author`, async () => {
    const { db, agents, p } = setup(1);
    await assert.rejects(
      new ResearchTasks(db).execute(
        "1:0:report:news",
        ["a", "b"],
        Date.now() + 10000,
        () => {},
        async (a) => {
          if (a === "a") throw new SyntaxError("bad");
          throw Error(last);
        },
      ),
    );
    closed(db);
    p.observeResearch();
    assert.equal(agents.get("a").jailed, true);
    assert.equal(agents.get("b").jailed, false);
    assert.equal(agents.get("master").jailed, false);
    db.close();
  });

test("legacy active view remains repairable; takeover closes it; DONE without old context repairs", () => {
  const { db, agents, p } = setup(1);
  legacy(db, "1:0:report:news:attempt:0", "a", "FAILED", Date.now());
  p.observeResearch();
  assert.equal(agents.get("a").jailed, false);
  db.put("epoch", "1", {
    id: "1",
    view: 1,
    status: "RUNNING",
    deadline: Date.now() + 10000,
  });
  p.observeResearch();
  assert.equal(agents.get("a").jailed, true);
  legacy(db, "1:0:report:news:attempt:1", "b", "DONE");
  p.observeResearch();
  assert.equal(db.all("research-task").length, 0);
  db.close();
});

test("policy reconciliation keeps real strikes and recovered release watermark", async () => {
  const { db, agents, p } = setup();
  const now = Date.now();
  db.put("quarantine", "a", { agent: "a", releasedAt: now - 1000 });
  db.put("quarantine", "a", {
    agent: "a",
    reason: "REPEATED_PLATFORM_FAILURE",
    until: now + 100000,
  });
  agents.update("a", { jailed: true });
  legacy(db, "1:0:report:old:attempt:0", "a", "FAILED", now - 2000);
  legacy(db, "1:0:report:new:attempt:0", "a", "FAILED", now - 500);
  closed(db);
  p.observeResearch(now);
  await p.recoverOperational(async () => true, now);
  assert.equal(agents.get("a").jailed, false);
  assert.equal(db.get<any>("quarantine", "a").releasedAt, now - 1000);
  assert.equal(
    db.get<any>("quarantine", "a").releaseReason,
    "TASK_PENALTY_RECONCILIATION",
  );
  p.failure("second", "a", now + 1);
  p.failure("third", "a", now + 2);
  assert.equal(agents.get("a").jailed, true);
  assert.equal(db.get<any>("quarantine", "a").releasedAt, now - 1000);
  db.close();
});

for (const race of ["threshold", "security", "replacement"])
  test(`async policy recovery rejects ${race} race`, async () => {
    const { db, agents, p } = setup(1);
    const now = Date.now();
    agents.update("a", { jailed: true });
    db.put("quarantine", "a", {
      agent: "a",
      reason: "REPEATED_PLATFORM_FAILURE",
      until: now + 10000,
    });
    await p.recoverOperational(async () => {
      if (race === "threshold") {
        legacy(db, "1:0:report:news:attempt:0", "a", "FAILED", now);
        closed(db);
      }
      if (race === "security") db.put("evidence", "proof", { agent: "a" });
      if (race === "replacement")
        db.put("quarantine", "a", {
          agent: "a",
          reason: "REPEATED_PLATFORM_FAILURE",
          until: now + 10000,
          replacement: true,
        });
      return true;
    }, now);
    assert.equal(agents.get("a").jailed, true);
    db.close();
  });

test("restart between retries preserves ACTIVE and frozen bounds; exhausted crash is reconciled", async () => {
  const { db, p, agents } = setup(1);
  const key = "1:0:report:news";
  let stopped = false;
  await assert.rejects(
    new ResearchTasks(db, {
      maxAttempts: 2,
      epoch: "1",
      view: 0,
    } as any).execute(
      key,
      ["a", "b"],
      Date.now() + 10000,
      () => {
        if (stopped) throw Error("stopped");
      },
      async () => {
        stopped = true;
        throw new SyntaxError("bad");
      },
    ),
  );
  p.observeResearch();
  assert.equal(db.get<any>("research-task", key).status, "ACTIVE");
  assert.equal(agents.get("a").jailed, false);
  assert.equal(
    await new ResearchTasks(db, {
      maxAttempts: 8,
      epoch: "1",
      view: 0,
    } as any).execute(
      key,
      ["a", "b"],
      Date.now() + 20000,
      () => {},
      async () => 42,
    ),
    42,
  );
  assert.equal(db.get<any>("research-task", key).maxAttempts, 2);
  const crash = "1:0:report:crash";
  db.put("research-task", crash, {
    ...db.get<any>("research-task", key),
    id: crash,
    status: "ACTIVE",
    finishedAt: undefined,
    resultAttemptId: undefined,
  });
  db.put("research-attempt", `${crash}:attempt:1`, {
    id: `${crash}:attempt:1`,
    taskId: crash,
    agent: "a",
    status: "FAILED",
    failure: "INVALID_OUTPUT",
    finishedAt: Date.now(),
  });
  p.observeResearch();
  assert.equal(db.get<any>("research-task", crash).status, "FAILED");
  assert.equal(agents.get("a").jailed, true);
  db.close();
});

test("missing legacy timestamp never becomes a polling-time offense or permits early release", async () => {
  const { db, p, agents } = setup(1);
  const now = Date.now();
  db.sql.exec("DROP TRIGGER records_history_insert");
  legacy(db, "1:0:report:news:attempt:0");
  closed(db);
  agents.update("a", { jailed: true });
  db.put("quarantine", "a", {
    agent: "a",
    reason: "REPEATED_PLATFORM_FAILURE",
    until: now + 10000,
  });
  p.observeResearch(now);
  await p.recoverOperational(async () => true, now + 1);
  assert.equal(agents.get("a").jailed, true);
  assert.equal(db.get<any>("quarantine", "a").until, now + 10000);
  await p.recoverOperational(async () => true, now + 10001);
  assert.equal(agents.get("a").jailed, false);
  db.close();
});

test("legacy exact incident fallback and history use occurrence time, not delayed observation", async () => {
  const { db, p, agents } = setup(1);
  const now = Date.now();
  db.sql.exec("DROP TRIGGER records_history_insert");
  legacy(db, "1:0:report:news:attempt:0");
  closed(db);
  db.put("incident", "research:1:0:report:news:attempt:0", {
    id: "research:1:0:report:news:attempt:0",
    agent: "a",
    reason: "INVALID_OUTPUT",
    at: now - 86400001,
  });
  p.observeResearch(now);
  assert.equal(agents.get("a").jailed, false);
  db.close();
});

test("malformed ownership is uncertainty and cannot automatically clear an existing jail", async () => {
  const { db, p, agents } = setup(1);
  const now = Date.now();
  legacy(db, "unrecognized-identity", "a", "FAILED", now);
  agents.update("a", { jailed: true });
  db.put("quarantine", "a", {
    agent: "a",
    reason: "REPEATED_PLATFORM_FAILURE",
    until: now + 10000,
  });
  await p.recoverOperational(async () => true, now);
  assert.equal(agents.get("a").jailed, true);
  db.close();
});

test("a genuinely new event extends jail once and preserved watermark excludes pre-release tasks", () => {
  const { db, p } = setup(1);
  const now = Date.now();
  db.put("quarantine", "a", { agent: "a", releasedAt: now - 100 });
  p.failure("one", "a", now);
  const first = db.get<any>("quarantine", "a").until;
  p.failure("one", "a", now + 100);
  assert.equal(db.get<any>("quarantine", "a").until, first);
  p.failure("two", "a", now + 200);
  assert.equal(db.get<any>("quarantine", "a").until, now + 10200);
  assert.equal(db.get<any>("quarantine", "a").releasedAt, now - 100);
  db.close();
});

test("runtime stop during resumable work retains identity and does not terminalize the task", async () => {
  const { db, p } = setup();
  const key = "1:0:report:stop";
  let stopped = false;
  await assert.rejects(
    new ResearchTasks(db, { resumable: true, maxAttempts: 1 }).execute(
      key,
      ["a"],
      Date.now() + 10000,
      () => {
        if (stopped) throw Error("runtime stopped");
      },
      async () => {
        stopped = true;
        throw Error("Agent tool aborted");
      },
    ),
  );
  p.observeResearch();
  assert.equal(db.get<any>("research-task", key).status, "ACTIVE");
  assert.equal(
    await new ResearchTasks(db, { resumable: true, maxAttempts: 1 }).execute(
      key,
      ["a"],
      Date.now() + 10000,
      () => {},
      async (_a, id) => id,
    ),
    `${key}:attempt:0`,
  );
  db.close();
});

test("DONE attempt and task writes roll back together if terminal persistence fails", async () => {
  const { db } = setup();
  const key = "1:0:report:atomic";
  db.sql.exec(
    `CREATE TRIGGER reject_task_done BEFORE UPDATE ON records WHEN NEW.kind='research-task' AND json_extract(NEW.data,'$.status')='DONE' BEGIN SELECT RAISE(ABORT,'injected terminal write failure'); END;`,
  );
  await assert.rejects(
    new ResearchTasks(db, { resumable: true }).execute(
      key,
      ["a"],
      Date.now() + 10000,
      () => {},
      async () => 42,
    ),
    /injected terminal write failure/,
  );
  assert.equal(db.get<any>("research-task", key).status, "ACTIVE");
  assert.equal(
    db.get<any>("research-attempt", `${key}:attempt:0`).status,
    "RUNNING",
  );
  db.close();
});

test("legacy quarantine exposes unresolved provenance without extending its deadline", () => {
  const { db, p } = setup(1);
  const now = Date.now();
  db.sql.exec("DROP TRIGGER records_history_insert");
  legacy(db, "1:0:report:news:attempt:0");
  closed(db);
  db.put("quarantine", "a", {
    agent: "a",
    reason: "REPEATED_PLATFORM_FAILURE",
    until: now + 10000,
  });
  p.observeResearch(now);
  const q = db.get<any>("quarantine", "a");
  assert.equal(q.unresolvedCount, 1);
  assert.equal(q.until, now + 10000);
  assert.equal(q.reconciliationBasis[0].provenance, "unresolved");
  db.close();
});

test("non-baseline legacy history ages out and BASELINE release fields remain valid watermarks", async () => {
  const { db, p, agents } = setup(1);
  const now = Date.now();
  legacy(db, "1:0:report:news:attempt:0");
  closed(db);
  p.observeResearch(now + 86401000);
  assert.equal(agents.get("a").jailed, false);
  db.sql
    .prepare(
      "INSERT INTO record_history(kind,id,operation,data,recorded_at) VALUES(?,?,?,?,?)",
    )
    .run(
      "quarantine",
      "a",
      "BASELINE",
      JSON.stringify({ agent: "a", releasedAt: now + 10 }),
      new Date(now + 10000).toISOString(),
    );
  db.put("quarantine", "a", {
    agent: "a",
    reason: "REPEATED_PLATFORM_FAILURE",
    until: now + 100000,
  });
  agents.update("a", { jailed: true });
  await p.recoverOperational(async () => true, now + 20);
  assert.equal(agents.get("a").jailed, false);
  assert.equal(db.get<any>("quarantine", "a").releasedAt, now + 10);
  db.close();
});

test("maintenance exhaustion retains the final attempt fault classification on replay", async () => {
  const { db, p } = setup();
  const key = "1:0:report:crash";
  const { hash } = await import("../src/protocol.js");
  const { classifyResearchFailure } = await import("../src/tasks.js");
  db.put("research-task", key, {
    id: key,
    version: 1,
    contextHash: hash({ workers: ["a"], context: key }),
    workers: ["a"],
    maxAttempts: 1,
    deadline: Date.now() + 10000,
    status: "ACTIVE",
    startedAt: Date.now(),
  });
  legacy(db, `${key}:attempt:0`, "a", "FAILED", Date.now());
  p.observeResearch();
  await assert.rejects(
    new ResearchTasks(db).execute(
      key,
      ["a"],
      Date.now() + 10000,
      () => {},
      async () => 42,
    ),
    (e) => classifyResearchFailure(e) === "INVALID_OUTPUT",
  );
  db.close();
});

for (const persisted of [false, true])
  test(`health deadline crossing blocks release for ${persisted ? "durable ACTIVE" : "legacy"} task`, async () => {
    const { db, agents } = setup(1);
    let time = Date.now();
    const started = time;
    const p = new Penalties(agents, new Epochs(db), 97, 1, 10000, () => time);
    db.put("epoch", "1", {
      id: "1",
      view: 0,
      status: "RUNNING",
      deadline: started + 10,
    });
    const key = "1:0:report:news";
    legacy(db, `${key}:attempt:0`, "a", "FAILED", started);
    if (persisted)
      db.put("research-task", key, {
        id: key,
        version: 1,
        epoch: "1",
        view: 0,
        contextHash: "context",
        workers: ["a"],
        maxAttempts: 2,
        deadline: started + 10,
        status: "ACTIVE",
        startedAt: started,
      });
    agents.update("a", { jailed: true });
    db.put("quarantine", "a", {
      agent: "a",
      reason: "REPEATED_PLATFORM_FAILURE",
      until: started + 10000,
      releasedAt: started - 1,
    });
    let probed = false;
    await p.recoverOperational(async () => {
      probed = true;
      time = started + 20;
      return true;
    }, started);
    assert.equal(probed, true);
    assert.equal(agents.get("a").jailed, true);
    assert.equal(db.get<any>("quarantine", "a").releasedAt, started - 1);
    if (persisted)
      assert.equal(db.get<any>("research-task", key).status, "FAILED");
    db.close();
  });

test("ordinary recovery writes the actual post-health commit timestamp", async () => {
  const { db, agents } = setup();
  let time = Date.now();
  const started = time;
  const p = new Penalties(agents, new Epochs(db), 97, 3, 10000, () => time);
  agents.update("a", { jailed: true });
  db.put("quarantine", "a", {
    agent: "a",
    reason: "REPEATED_PLATFORM_FAILURE",
    until: started - 1,
  });
  await p.recoverOperational(async () => {
    time = started + 20;
    return true;
  }, started);
  assert.equal(db.get<any>("quarantine", "a").releasedAt, started + 20);
  assert.equal(db.get<any>("quarantine", "a").reconciledAt, started + 20);
  db.close();
});

test("legacy DONE beyond reduced retry bound is reused without increasing dispatch allowance", async () => {
  const { db } = setup();
  const key = "1:0:report:legacy";
  const { hash } = await import("../src/protocol.js");
  const contextHash = hash({ workers: ["a"], context: key });
  for (const [index, status] of [
    [0, "FAILED"],
    [1, "DONE"],
  ] as const)
    db.put("research-attempt", `${key}:attempt:${index}`, {
      id: `${key}:attempt:${index}`,
      agent: "a",
      contextHash,
      status,
      failure: status === "FAILED" ? "INVALID_OUTPUT" : undefined,
      result: status === "DONE" ? 42 : undefined,
    });
  let dispatched = false;
  const tasks = new ResearchTasks(db, { maxAttempts: 1 });
  for (let i = 0; i < 2; i++)
    assert.equal(
      await tasks.execute(
        key,
        ["a"],
        Date.now() + 10000,
        () => {},
        async () => {
          dispatched = true;
          return 99;
        },
      ),
      42,
    );
  assert.equal(dispatched, false);
  const task = db.get<any>("research-task", key);
  assert.equal(task.status, "DONE");
  assert.equal(task.maxAttempts, 1);
  assert.equal(task.resultAttemptId, `${key}:attempt:1`);
  db.close();
});

for (const guard of ["context", "author", "fence"] as const)
  test(`legacy DONE beyond retry bound still checks ${guard}`, async () => {
    const { db } = setup();
    const key = "1:0:report:legacy";
    const { hash } = await import("../src/protocol.js");
    db.put("research-attempt", `${key}:attempt:1`, {
      id: `${key}:attempt:1`,
      status: "DONE",
      result: 42,
      agent: guard === "author" ? "b" : "a",
      contextHash:
        guard === "context"
          ? "different"
          : hash({ workers: ["a"], context: key }),
    });
    let dispatched = false;
    await assert.rejects(
      new ResearchTasks(db, { maxAttempts: 1 }).execute(
        key,
        ["a"],
        Date.now() + 10000,
        () => {
          if (guard === "fence") throw Error("fenced generation");
        },
        async () => {
          dispatched = true;
          return 99;
        },
      ),
      guard === "context"
        ? /context conflict/
        : guard === "author"
          ? /author unavailable/
          : /fenced generation/,
    );
    assert.equal(dispatched, false);
    assert.equal(db.get<any>("research-task", key).status, "ACTIVE");
    db.close();
  });
