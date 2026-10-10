import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { ToolJournal } from "../src/tool-journal.js";
const call = {
  agent: "a",
  runId: "round:role:attempt:0",
  sequence: 0,
  tool: "news",
  input: { query: "BNB" },
};
test("tool dispatch is durable before IO; result is atomic and replay does not repeat IO", async () => {
  const db = new Store(":memory:");
  try {
    let calls = 0;
    const journal = new ToolJournal(db);
    const run = async () => {
      calls++;
      assert.equal(db.all<any>("agent-tool-call")[0].status, "RUNNING");
      return { news: ["source"] };
    };
    assert.deepEqual(await journal.run(call, run), { news: ["source"] });
    assert.deepEqual(await new ToolJournal(db).run(call, run), {
      news: ["source"],
    });
    assert.equal(calls, 1);
    assert.equal(db.all<any>("agent-tool-call")[0].status, "DONE");
    await assert.rejects(
      journal.run({ ...call, input: { query: "ETH" } }, run),
      /conflict/,
    );
    assert.equal(calls, 1);
  } finally {
    db.close();
  }
});
test("failure and cancellation are durable, bounded and cannot silently retry", async () => {
  const db = new Store(":memory:");
  try {
    const journal = new ToolJournal(db);
    let calls = 0;
    const fail = async () => {
      calls++;
      throw Error("secret-provider-url");
    };
    await assert.rejects(journal.run(call, fail), /failed/);
    await assert.rejects(journal.run(call, fail), /failed/);
    assert.equal(calls, 1);
    assert.equal(db.all<any>("agent-tool-call")[0].status, "FAILED");
    assert.ok(
      !JSON.stringify(db.all("agent-tool-call")).includes(
        "secret-provider-url",
      ),
    );
    const abort = new AbortController();
    await assert.rejects(
      journal.run(
        { ...call, sequence: 1 },
        async () => {
          abort.abort();
          return { late: true };
        },
        abort.signal,
      ),
      /aborted/,
    );
    assert.equal(db.all<any>("agent-tool-call")[1].status, "ABORTED");
    assert.equal(db.all("agent-tool").length, 0);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(
      journal.run({ ...call, sequence: 2 }, fail, stopped.signal),
      /aborted/,
    );
    assert.equal(calls, 1);
    assert.equal(db.all<any>("agent-tool-call")[2].dispatched, false);
  } finally {
    db.close();
  }
});
test("concurrent and interrupted identities cannot double-dispatch; limit refusal is stored", async () => {
  const db = new Store(":memory:");
  try {
    const journal = new ToolJournal(db);
    let release!: () => void;
    const pending = journal.run(
      call,
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    await assert.rejects(
      new ToolJournal(db).run(call, async () => assert.fail("duplicate IO")),
      /uncertain/,
    );
    release();
    await pending;
    const row = db.all<any>("agent-tool-call")[0];
    db.put("agent-tool-call", `${call.runId}:tool:0`, {
      ...row,
      status: "RUNNING",
    });
    db.remove("agent-tool", `${call.runId}:tool:0`);
    await assert.rejects(
      new ToolJournal(db).run(call, async () => assert.fail("restart IO")),
      /uncertain/,
    );
    await assert.rejects(
      journal.run(
        { ...call, sequence: 1 },
        async () => assert.fail("limit IO"),
        undefined,
        "TOOL_LIMIT",
      ),
      /limit/,
    );
    assert.equal(db.all<any>("agent-tool-call")[1].status, "REJECTED");
  } finally {
    db.close();
  }
});
test("failure to persist tool output leaves an uncertain dispatch, not a false completed result", async () => {
  const db = new Store(":memory:");
  try {
    db.sql.exec(
      `CREATE TRIGGER fail_tool BEFORE INSERT ON records WHEN NEW.kind='agent-tool' BEGIN SELECT RAISE(ABORT,'disk failure'); END;`,
    );
    await assert.rejects(
      new ToolJournal(db).run(call, async () => ({ ok: true })),
      /disk failure/,
    );
    assert.equal(db.all<any>("agent-tool-call")[0].status, "RUNNING");
    assert.equal(db.all("agent-tool").length, 0);
  } finally {
    db.close();
  }
});

test("interrupted tool work survives file reopen and advances through bounded research attempts", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { hash } = await import("../src/protocol.js");
  const { classifyResearchFailure, ResearchTasks } =
    await import("../src/tasks.js");
  const dir = mkdtempSync(join(tmpdir(), "a2a-tool-"));
  const path = join(dir, "test.sqlite");
  let db = new Store(path);
  try {
    db.insert("agent-tool-call", `${call.runId}:tool:0`, {
      ...call,
      fingerprint: hash({ name: call.tool, args: call.input }),
      status: "RUNNING",
      dispatched: true,
      startedAt: 1,
    });
    db.close();
    db = new Store(path);
    await assert.rejects(
      new ToolJournal(db).run(call, async () => assert.fail("repeat")),
      (error) => {
        assert.equal(classifyResearchFailure(error), "PROVIDER");
        return true;
      },
    );
    assert.deepEqual(
      await new ResearchTasks(db, { maxAttempts: 2, resumable: true }).execute(
        "round:role",
        ["a"],
        Date.now() + 10000,
        () => {},
        (agent, runId) =>
          new ToolJournal(db).run({ ...call, agent, runId }, async () => ({
            ok: true,
          })),
      ),
      { ok: true },
    );
    assert.equal(db.all<any>("agent-tool-call")[0].status, "RUNNING");
    assert.equal(db.all<any>("agent-tool-call")[1].status, "DONE");
    assert.deepEqual(
      db.all<any>("research-attempt").map((r) => r.status),
      ["FAILED", "DONE"],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
