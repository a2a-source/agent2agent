import { test } from "node:test";
import assert from "node:assert/strict";
import { balancedAssignments, ResearchTasks } from "../src/tasks.js";
import { Store } from "../src/store.js";
test("assignment protocol repairs collapsed Master assignments and covers workers evenly", () => {
  const roles = ["a", "b", "c", "d", "e", "f"],
    workers = ["1", "2", "3", "4", "5", "6"];
  const result = balancedAssignments(
    { assignments: roles.map((role) => ({ role, agent: "1" })) },
    roles,
    workers,
  );
  assert.equal(result.repaired, true);
  assert.equal(new Set(result.assignments.map((a) => a.agent)).size, 6);
  assert.deepEqual(
    balancedAssignments(null, roles, ["1", "2"]).assignments.map(
      (a) => a.agent,
    ),
    ["1", "2", "1", "2", "1", "2"],
  );
});
test("task execution bounds concurrency, persists attempt identity and fences late results", async () => {
  const db = new Store(":memory:");
  const tasks = new ResearchTasks(db, { concurrency: 2, maxAttempts: 2 });
  let live = 0,
    peak = 0;
  const result = await tasks.map(["a", "b", "c", "d"], async (role) =>
    tasks.execute(
      role,
      ["w", "x"],
      Date.now() + 1000,
      () => {},
      async (agent, id) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 10));
        live--;
        return { agent, id };
      },
    ),
  );
  assert.equal(peak, 2);
  assert.equal(result.length, 4);
  assert.equal(db.all("research-attempt").length, 4);
  const restarted = new ResearchTasks(db);
  await restarted.execute(
    "a",
    ["w", "x"],
    Date.now() + 1000,
    () => {},
    async () => {
      throw Error("must use cache");
    },
  );
  await assert.rejects(
    tasks.execute(
      "late",
      ["w"],
      Date.now() + 5,
      () => {},
      async () => {
        await new Promise((r) => setTimeout(r, 15));
        return "late";
      },
    ),
    /deadline/,
  );
  db.close();
});

test("HTTP provider circuit recovers automatically and retry dispatch preserves ambiguous holds", async () => {
  const { createServer } = await import("node:http");
  const { Llm } = await import("../src/llm.js");
  const { Budget } = await import("../src/budget.js");
  const { loadConfig } = await import("./test-config.js");
  let unavailable = true,
    probes = 0,
    posts = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") {
        probes++;
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      posts++;
      if (unavailable) {
        res.statusCode = 503;
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"recovered"}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    config = loadConfig().llm;
  config.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  // Real loopback HTTP can be delayed when the full test suite saturates workers.
  config.timeoutMs = 1000;
  budget.credit("a", "fund", 10000000000000000n);
  const llm = new Llm(db, budget, config, "test"),
    tasks = new ResearchTasks(db, { maxAttempts: 2 });
  try {
    await assert.rejects(
      tasks.execute(
        "failed",
        ["a"],
        Date.now() + 10000,
        () => {},
        (agent, id) => llm.call(agent, id, "system", "input"),
      ),
      /503/,
    );
    assert.equal(posts, 2);
    assert.equal(db.all("reservation").length, 2);
    await assert.rejects(
      llm.call("a", "blocked", "system", "input"),
      /circuit/,
    );
    assert.equal(db.all("reservation").length, 2);
    unavailable = false;
    await new Promise((r) => setTimeout(r, config.timeoutMs + 10));
    const restarted = new Llm(db, budget, config, "test");
    assert.equal(
      (await restarted.call("a", "recovered", "system", "input")).summary,
      "recovered",
    );
    assert.equal(probes, 1);
    const before = budget.available("a");
    await assert.rejects(
      new ResearchTasks(db).execute(
        "failed",
        ["a"],
        Date.now() + 1000,
        () => {},
        (agent, id) => restarted.call(agent, id, "system", "input"),
      ),
    );
    assert.equal(budget.available("a"), before);
    assert.equal(posts, 3);
  } finally {
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("crashed attempt gets a distinct bounded fallback identity and failure map drains dispatched work", async () => {
  const db = new Store(":memory:");
  db.put("research-attempt", "crash:attempt:0", {
    id: "crash:attempt:0",
    agent: "a",
    status: "RUNNING",
  });
  const tasks = new ResearchTasks(db, { concurrency: 2, maxAttempts: 2 });
  assert.equal(
    await tasks.execute(
      "crash",
      ["a", "b"],
      Date.now() + 1000,
      () => {},
      async (agent, id) => {
        assert.equal(id, "crash:attempt:1");
        return agent;
      },
    ),
    "b",
  );
  let drained = false;
  await assert.rejects(
    tasks.map([1, 2], async (n) => {
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 2));
        throw Error("failure");
      }
      await new Promise((r) => setTimeout(r, 20));
      drained = true;
    }),
  );
  assert.equal(drained, true);
  assert.equal(
    balancedAssignments({ assignments: [null] }, ["a"], ["w"]).repaired,
    true,
  );
  assert.equal(
    balancedAssignments({ assignments: "bad" }, ["a"], ["w"]).repaired,
    true,
  );
  db.close();
});

test("real HTTP research dispatch caps parallel provider requests", async () => {
  const { createServer } = await import("node:http");
  const { Llm } = await import("../src/llm.js");
  const { Budget } = await import("../src/budget.js");
  const { loadConfig } = await import("./test-config.js");
  let inflight = 0,
    peak = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      inflight++;
      peak = Math.max(peak, inflight);
      setTimeout(() => {
        inflight--;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "{}" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
      }, 15);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    config = loadConfig().llm;
  config.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  budget.credit("a", "fund", 10000000000000000n);
  try {
    const tasks = new ResearchTasks(db, { concurrency: 2 }),
      llm = new Llm(db, budget, config, "test");
    await tasks.map(["r1", "r2", "r3", "r4"], (role) =>
      tasks.execute(
        role,
        ["a"],
        Date.now() + 1000,
        () => {},
        (agent, id) => llm.call(agent, id, "system", role),
      ),
    );
    assert.equal(peak, 2);
    assert.equal(db.all("reservation").length, 4);
  } finally {
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("restored completed research rejects different workers or request context", async () => {
  const db = new Store(":memory:"),
    tasks = new ResearchTasks(db);
  await tasks.execute(
    "context",
    ["a"],
    Date.now() + 1000,
    () => {},
    async () => 1,
    { source: "old" },
  );
  await assert.rejects(
    tasks.execute(
      "context",
      ["a"],
      Date.now() + 1000,
      () => {},
      async () => 2,
      { source: "new" },
    ),
    /context conflict/,
  );
  await assert.rejects(
    tasks.execute(
      "context",
      ["b"],
      Date.now() + 1000,
      () => {},
      async () => 2,
      { source: "old" },
    ),
    /context conflict/,
  );
  db.close();
});

test("aborting slow provider health probe creates no paid reservation", async () => {
  const { createServer } = await import("node:http");
  const { Llm } = await import("../src/llm.js");
  const { Budget } = await import("../src/budget.js");
  const { loadConfig } = await import("./test-config.js");
  const { hash } = await import("../src/protocol.js");
  const server = createServer((_req, res) => {
    setTimeout(() => res.end("{}"), 100);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    config = loadConfig().llm;
  config.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  budget.credit("a", "fund", 10000000000000000n);
  db.put(
    "provider-circuit",
    hash({ endpoint: config.endpoint, model: config.model }),
    { failures: 2, retryAt: 0 },
  );
  const controller = new AbortController(),
    llm = new Llm(db, budget, config, "test");
  try {
    const promise = llm.call(
      "a",
      "cancelled",
      "system",
      "input",
      controller.signal,
    );
    setTimeout(() => controller.abort(Error("epoch deadline expired")), 10);
    await assert.rejects(promise, /deadline/);
    assert.equal(db.all("reservation").length, 0);
    assert.equal(db.all("llm-call").length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});

test("Runner repairs six-worker collapse over HTTP and replaces only a failed research role", async () => {
  const { createServer } = await import("node:http");
  const { generateKeyPairSync } = await import("node:crypto");
  const { Llm } = await import("../src/llm.js");
  const { Budget } = await import("../src/budget.js");
  const { loadConfig } = await import("./test-config.js");
  const { Agents } = await import("../src/agents.js");
  const { Epochs } = await import("../src/epochs.js");
  const { Runner } = await import("../src/runner.js");
  const { WalletVault } = await import("../src/wallet.js");
  let failRole: string | undefined,
    failedAgent: string | undefined,
    collapse = true,
    live = 0,
    peak = 0;
  const dispatches: { role: string; agent: string; epoch: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const input = JSON.parse(JSON.parse(raw).messages[1].content);
      let result: any;
      if (input.workers)
        result = {
          assignments: input.roles.map((role: string, i: number) => ({
            role,
            agent: input.workers[collapse ? 0 : i % input.workers.length],
          })),
        };
      else if (input.reports) result = { signals: [], risks: ["no data"] };
      else {
        dispatches.push(input.identity);
        live++;
        peak = Math.max(peak, live);
        if (input.identity.role === failRole && !failedAgent) {
          failedAgent = input.identity.agent;
          result = {};
        } else
          result = {
            summary: "independent research",
            sources: [],
            missing: ["no verified data"],
          };
      }
      setTimeout(() => {
        if (input.identity) live--;
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(result) } }],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }),
        );
      }, 5);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:");
  try {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      agents = new Agents(
        db,
        new WalletVault(
          keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
          keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          "test",
        ),
      ),
      budget = new Budget(db),
      epochs = new Epochs(db),
      config = loadConfig();
    config.llm.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
    config.network.committeeSize = 7;
    const runner = new Runner(
      agents,
      budget,
      epochs,
      new Llm(db, budget, config.llm, "test"),
      config,
      { concurrency: 2, maxAttempts: 2 },
    );
    for (let i = 0; i < 7; i++) {
      const user = agents.createUser(`test-${i}`),
        agent = agents.create(user.id, "launch", {
          name: "A",
          symbol: "A",
          meta: "bafy",
        });
      agents.update(agent.id, { launch: "CONFIRMED", token: agent.wallet });
      budget.credit(agent.id, agent.id, 10000000000000000n);
      db.put("chain-state", agent.id, {
        known: true,
        bonded: "300000000000000000",
        exit: "0",
        observedAt: Date.now(),
      });
    }
    const first = epochs.open(0, runner.candidates(), config.network),
      result = await runner.run(first);
    assert.equal(new Set(result.reports.map((r) => r.agent)).size, 6);
    assert.equal(
      db.get<any>("research-assignment", `${first.id}:${first.view}`).repaired,
      true,
    );
    assert.equal(peak, 2);
    // Simulate recovery after paid synthesis, BEFORE candidate freeze/signature collection.
    db.remove("confirmation-proposal", first.id);
    for (const row of db.entries("confirmation-intent"))
      db.remove("confirmation-intent", row.id);
    for (const row of db.entries("confirmation-vote"))
      db.remove("confirmation-vote", row.id);
    const savedEpoch = epochs.get(first.id);
    const roleKey = `${first.id}:report:${config.roles[0]!.id}`;
    const savedReport = db.get<any>("report", roleKey);
    db.put("epoch", first.id, { ...first, status: "RUNNING" });
    db.put("report", roleKey, {
      ...savedReport,
      report: { ...savedReport.report, summary: "changed restored report" },
    });
    await assert.rejects(
      new Runner(
        agents,
        budget,
        epochs,
        new Llm(db, budget, config.llm, "test"),
        config,
      ).run(first),
      /context conflict/,
    );
    assert.equal(epochs.get(first.id).status, "RUNNING");
    db.put("report", roleKey, savedReport);
    const savedSource = db.get<any>("source", roleKey);
    db.put("source", roleKey, { ...savedSource, data: { changed: true } });
    await assert.rejects(runner.run(first), /context conflict/);
    db.put("source", roleKey, savedSource);
    const excludedWorker = result.reports[0]!.agent;
    agents.update(excludedWorker, { jailed: true });
    await assert.rejects(runner.run(first), /context conflict/);
    agents.update(excludedWorker, { jailed: false });
    db.put("epoch", first.id, savedEpoch);
    collapse = false;
    failRole = config.roles[0]!.id;
    const second = epochs.open(1, runner.candidates(), config.network),
      fallback = await runner.run(second);
    const replacement = fallback.reports.find((r) => r.role === failRole)!;
    assert.notEqual(replacement.agent, failedAgent);
    assert.notEqual(replacement.agent, second.master);
    assert.ok(second.committee.some((a) => a.id === replacement.agent));
    assert.equal(dispatches.filter((d) => d.epoch === second.id).length, 7);
    assert.equal(
      db
        .all<any>("research-attempt")
        .filter((a) => a.failure === "INVALID_OUTPUT").length,
      1,
    );
    assert.equal(epochs.get(second.id).status, "PUBLISHED");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  }
});

test("resumable framework reenters crashed attempt with its original identity", async () => {
  const db = new Store(":memory:");
  try {
    const { hash } = await import("../src/protocol.js");
    const key = "resume",
      workers = ["a"],
      context = { task: 1 };
    db.put("research-attempt", key + ":attempt:0", {
      id: key + ":attempt:0",
      agent: "a",
      contextHash: hash({ workers, context }),
      status: "RUNNING",
    });
    const tasks = new ResearchTasks(db, { maxAttempts: 1, resumable: true });
    let called = "";
    assert.equal(
      await tasks.execute(
        key,
        workers,
        Date.now() + 1000,
        () => {},
        async (_a, id) => {
          called = id;
          return 42;
        },
        context,
      ),
      42,
    );
    assert.equal(called, key + ":attempt:0");
  } finally {
    db.close();
  }
});
