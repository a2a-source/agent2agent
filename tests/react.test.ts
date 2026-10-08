import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Llm } from "../src/llm.js";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { loadConfig } from "./test-config.js";
test("budgeted chat preserves tool calls, accounts every turn and replays cached results", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tool-1",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: '{"query":"BNB"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    cfg = loadConfig().llm;
  cfg.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  budget.credit("agent", "fund", 10000000n);
  const llm = new Llm(db, budget, cfg, "local-test");
  try {
    const request = {
      messages: [{ role: "user", content: "research" }],
      tools: [
        {
          type: "function",
          function: { name: "web_search", parameters: { type: "object" } },
        },
      ],
    };
    const result = await llm.chat("agent", "turn:0", request);
    assert.equal(
      result.choices[0].message.tool_calls[0].function.name,
      "web_search",
    );
    assert.equal(budget.available("agent"), 9999960n);
    await llm.chat("agent", "turn:0", request);
    assert.equal(calls, 1);
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("LangChain ReAct runs without usage, charges both requests and resumes without replay", async () => {
  const { AgentRuntime } = await import("../src/agent-runtime.js");
  const { z } = await import("zod");
  let calls = 0,
    tools = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw);
      calls++;
      const observed = b.messages.some((m: any) => m.role === "tool");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "completion-" + calls,
          object: "chat.completion",
          model: "test",
          choices: [
            {
              index: 0,
              finish_reason: observed ? "stop" : "tool_calls",
              message: observed
                ? {
                    role: "assistant",
                    content: '{"summary":"observed","sources":[],"missing":[]}',
                  }
                : {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "search-1",
                        type: "function",
                        function: {
                          name: "search",
                          arguments: '{"query":"BNB"}',
                        },
                      },
                    ],
                  },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    cfg = loadConfig().llm;
  cfg.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  budget.credit("a", "fund", 100000000000n);
  try {
    const runtime = new AgentRuntime(new Llm(db, budget, cfg, "test"), {
      maxToolRounds: 10,
      maxToolCalls: 20,
    });
    const supplied = [
      {
        name: "search",
        description: "search public data",
        schema: z.object({ query: z.string() }),
        run: async () => {
          tools++;
          return { data: "BNB", sources: [] };
        },
      },
    ];
    const result = await runtime.run(
      "a",
      "research",
      "Return JSON",
      "research",
      supplied,
    );
    assert.equal(result.value.summary, "observed");
    assert.equal(calls, 2);
    assert.equal(tools, 1);
    assert.equal(db.all("llm-call").length, 2);
    assert.equal(
      db.all<any>("llm-request").reduce((n, r) => n + BigInt(r.usdMicros), 0n),
      20000n,
    );
    assert.equal(budget.available("a"), 99999999920n);
    await assert.rejects(
      runtime.run(
        "a",
        "research",
        "Return JSON",
        "research",
        supplied,
        undefined,
        { type: "object" },
      ),
      /Agent request conflict/,
    );
    // Simulate process death after persisted turns/tools but before final runtime result.
    db.remove("agent-result", "research");

    await runtime.run("a", "research", "Return JSON", "research", supplied);
    assert.equal(calls, 2);
    assert.equal(tools, 1);
    db.remove("agent-result", "research");
    const uncertain = db.get<any>("llm-call", "research:model:1")!;
    db.put("llm-call", "research:model:1", {
      ...uncertain,
      status: "IN_FLIGHT",
    });
    await assert.rejects(
      runtime.run("a", "research", "Return JSON", "research", supplied),
      /uncertain LLM/,
    );
    assert.equal(calls, 2);
    assert.equal(tools, 1);
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("LLM rotates only explicit 429 responses and enforces the shared local request ceiling", async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization === "Bearer key-one") {
        res.statusCode = 429;
        res.setHeader("retry-after", "60");
        res.end("{}");
      } else
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    c = loadConfig().llm;
  c.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  (c as any).requestLimitPerDay = 2;
  budget.credit("a", "fund", 100000000000n);
  try {
    const llm = new Llm(db, budget, c, "key-one\nkey-two");
    assert.equal((await llm.call("a", "rotation", "system", "input")).ok, true);
    assert.deepEqual(seen, ["Bearer key-one", "Bearer key-two"]);
    const balance = budget.available("a");
    await assert.rejects(
      llm.call("a", "limit", "system", "input"),
      /request limit/,
    );
    assert.equal(seen.length, 2);
    assert.equal(budget.available("a"), balance);
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("ReAct stops tools at the configured round bound even if the model keeps requesting them", async () => {
  const { AgentRuntime } = await import("../src/agent-runtime.js");
  const { z } = await import("zod");
  let calls = 0,
    executions = 0;
  let finalBody: any, firstBody: any;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (b) => (raw += b));
    req.on("end", () => {
      calls++;
      const body = JSON.parse(raw);
      if (calls === 1) firstBody = body;
      if (calls === 2) {
        finalBody = body;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "t" + calls,
                    type: "function",
                    function: { name: "search", arguments: "{}" },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    c = loadConfig().llm;
  c.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  budget.credit("a", "fund", 100000000000n);
  try {
    const runtime = new AgentRuntime(new Llm(db, budget, c, "test"), {
      maxToolRounds: 1,
      maxToolCalls: 1,
    });
    await assert.rejects(
      runtime.run(
        "a",
        "limit-loop",
        "Return JSON",
        "research",
        [
          {
            name: "search",
            description: "search",
            schema: z.object({}),
            run: async () => {
              executions++;
              return { sources: [] };
            },
          },
        ],
        undefined,
        {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      ),
    );
    assert.equal(firstBody.response_format, undefined);
    assert.equal(finalBody.response_format.type, "json_schema");
    assert.equal(finalBody.response_format.json_schema.strict, true);
    assert.equal(finalBody.tool_choice, "none");
    assert.match(finalBody.messages.at(-1).content, /Tool budget exhausted/);
    assert.equal(calls, 2);
    assert.equal(executions, 1);
    assert.equal(
      db.all<any>("reservation").filter((r) => r.state === "UNKNOWN").length,
      0,
    );
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("request fees are independent of usage, absent content and provider errors", async () => {
  let withError = false;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ...(withError ? { error: { code: 503 } } : {}),
          choices: [{ message: { role: "assistant", content: null } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    c = loadConfig().llm;
  c.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  budget.credit("a", "fund", 1000000n);
  try {
    const llm = new Llm(db, budget, c, "test");
    await assert.rejects(
      llm.chat("a", "empty", { messages: [] }),
      /content unavailable/,
    );
    assert.equal(budget.account("a").reserved, "0");
    assert.equal(budget.available("a"), 999960n);
    withError = true;
    await assert.rejects(
      llm.chat("a", "error-with-usage", { messages: [] }),
      /provider error 503/,
    );
    assert.equal(budget.account("a").reserved, "0");
    assert.equal(budget.available("a"), 999920n);
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("provider failures retain only bounded diagnostic metadata, including HTTP 200 errors", async () => {
  let received: any;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "gen-fixture",
          error: { code: 502, message: "SECRET echoed text" },
          choices: [
            {
              finish_reason: "error",
              message: { content: null, reasoning: "SECRET reasoning" },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    c = loadConfig().llm;
  c.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  (c as any).reasoningEffort = "none";
  budget.credit("a", "fund", 100000000000n);
  try {
    const llm = new Llm(db, budget, c, "SECRET key");
    await assert.rejects(
      llm.chat("a", "diagnostic", { messages: [] }),
      /LLM provider error 502/,
    );
    const row = db.get<any>("llm-call", "diagnostic");
    assert.equal(row.diagnostic.providerErrorCode, 502);
    assert.equal(row.diagnostic.generationId, "gen-fixture");
    assert.equal(JSON.stringify(row).includes("SECRET"), false);
    assert.deepEqual(received.reasoning, { effort: "none" });
    assert.equal(budget.account("a").reserved, "0");
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
