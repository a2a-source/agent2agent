import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { classifyResearchFailure, ResearchTasks } from "../src/tasks.js";
import { AgentRuntime } from "../src/agent-runtime.js";
import { Llm } from "../src/llm.js";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { loadConfig } from "./test-config.js";
import { loadConfig as load } from "../src/config.js";
const finalName = "a2a_final_output";
const schema = {
  type: "object",
  properties: { summary: { type: "string", maxLength: 30 } },
  required: ["summary"],
  additionalProperties: false,
};
const call = (name: string, args: string, id = "call-1") => ({
  id,
  type: "function",
  function: { name, arguments: args },
});
const message = (...calls: any[]) => ({
  role: "assistant",
  content: null,
  tool_calls: calls,
});
async function fixture(
  reply: (body: any, turn: number) => any,
  fn: (x: any) => Promise<void>,
  rounds = 10,
  limit = 20,
) {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const answer = reply(body, bodies.length);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          answer.error
            ? answer
            : {
                choices: [
                  {
                    index: 0,
                    finish_reason: answer.tool_calls ? "tool_calls" : "stop",
                    message: answer,
                  },
                ],
              },
        ),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    cfg = loadConfig().llm;
  cfg.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  cfg.structuredOutputs = true;
  budget.credit("a", "fund", 100000n);
  const llm = new Llm(db, budget, cfg, "test");
  const runtime = new AgentRuntime(llm, {
    maxToolRounds: rounds,
    maxToolCalls: limit,
    finalOutputMode: "tool",
  } as any);
  let executions = 0;
  const tools = [
    {
      name: "search",
      description: "search",
      schema: z.object({}),
      run: async () => {
        executions++;
        return { observed: true };
      },
    },
  ];
  const run = (id = "task", supplied = tools, output: any = schema) =>
    runtime.run("a", id, "Research", "input", supplied, undefined, output);
  try {
    await fn({
      runtime,
      llm,
      db,
      budget,
      bodies,
      tools,
      run,
      executions: () => executions,
    });
  } finally {
    db.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("config accepts tool output opt-in, defaults text and rejects unknown modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-output-")),
    path = join(dir, "config.json");
  try {
    assert.equal((loadConfig().agent as any).finalOutputMode, "text");
    writeFileSync(path, JSON.stringify({ agent: { finalOutputMode: "tool" } }));
    assert.equal((load(path).agent as any).finalOutputMode, "tool");
    writeFileSync(
      path,
      JSON.stringify({ agent: { finalOutputMode: "repair" } }),
    );
    assert.throws(() => load(path));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("tool final uses framework structured response, no provider schema or research charge, and replays", async () => {
  await fixture(
    () => message(call(finalName, '{"summary":"line\\nQBTC"}')),
    async ({ run, bodies, db, budget, llm, tools }: any) => {
      const result = await run();
      assert.deepEqual(result, {
        value: { summary: "line\nQBTC" },
        observations: [],
      });
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0].response_format, undefined);
      assert.deepEqual(
        bodies[0].tools.map((t: any) => t.function.name).sort(),
        [finalName, "search"],
      );
      assert.equal(db.all("agent-tool-call").length, 0);
      assert.equal(db.all("llm-call").length, 1);
      assert.equal(budget.available("a"), 99960n);
      assert.equal(
        db.get("agent-context", "task").config.finalOutputMode,
        "tool",
      );
      db.remove("agent-result", "task");
      assert.deepEqual(await run(), result);
      assert.equal(bodies.length, 1);
      const text = new AgentRuntime(llm, {
        maxToolRounds: 10,
        maxToolCalls: 20,
        finalOutputMode: "text",
      } as any);
      await assert.rejects(
        text.run("a", "task", "Research", "input", tools, undefined, schema),
        /Agent request conflict/,
      );
      db.remove("agent-result", "task");
      await assert.rejects(
        text.run("a", "task", "Research", "input", tools, undefined, schema),
        /Agent request conflict/,
      );
    },
  );
});

test("eleventh call retains only forced final output and all ten research observations replay", async () => {
  await fixture(
    (_body, turn) =>
      turn <= 10
        ? message(call("search", "{}", `search-${turn}`))
        : message(call(finalName, '{"summary":"done"}')),
    async ({ run, bodies, executions, db, budget }: any) => {
      const result = await run();
      assert.equal(result.value.summary, "done");
      assert.equal(result.observations.length, 10);
      assert.equal(executions(), 10);
      assert.equal(bodies.length, 11);
      assert.deepEqual(
        bodies[10].tools.map((t: any) => t.function.name),
        [finalName],
      );
      assert.deepEqual(bodies[10].tool_choice, {
        type: "function",
        function: { name: finalName },
      });
      assert.equal(bodies[10].response_format, undefined);
      assert.equal(db.all("llm-call").length, 11);
      assert.equal(budget.available("a"), 99560n);
      db.remove("agent-result", "task");
      assert.deepEqual(await run(), result);
      assert.equal(bodies.length, 11);
      assert.equal(executions(), 10);
    },
  );
});

for (const [label, answer] of [
  ["invalid schema", message(call(finalName, '{"summary":42}'))],
  [
    "overlong output",
    message(call(finalName, JSON.stringify({ summary: "x".repeat(31) }))),
  ],
  [
    "multiple output",
    message(
      call(finalName, '{"summary":"a"}'),
      call(finalName, '{"summary":"b"}', "call-2"),
    ),
  ],
  ["malformed arguments", message(call(finalName, '{"summary":"bad\\QBTC"}'))],
  [
    "fenced arguments",
    message(call(finalName, '```json\n{"summary":"a"}\n```')),
  ],
  [
    "fenced text fallback",
    { role: "assistant", content: '```json\n{"summary":"a"}\n```' },
  ],
  ["provider error", { error: { code: 502 } }],
] as const)
  test(`tool mode rejects ${label} without repair calls and retains paid ledger`, async () => {
    await fixture(
      () => answer,
      async ({ run, bodies, db, budget }: any) => {
        await assert.rejects(run(), (error) => {
          assert.equal(
            classifyResearchFailure(error),
            label === "provider error" ? "PROVIDER" : "INVALID_OUTPUT",
          );
          return true;
        });
        assert.equal(bodies.length, 1);
        assert.equal(db.get("agent-result", "task"), undefined);
        assert.equal(db.all("llm-call").length, 1);
        assert.equal(budget.available("a"), 99960n);
        assert.equal(budget.account("a").reserved, "0");
      },
    );
  });

test("tool mode refuses missing schema and reserved research name before dispatch", async () => {
  await fixture(
    () => message(call(finalName, '{"summary":"a"}')),
    async ({ run, bodies, tools }: any) => {
      await assert.rejects(
        run("no-schema", tools, null),
        /requires.*outputSchema/,
      );
      await assert.rejects(
        run("collision", [{ ...tools[0], name: finalName }]),
        /reserved/,
      );
      assert.equal(bodies.length, 0);
    },
  );
});

test("last round rejects research calls before execution, even alongside a valid final", async () => {
  await fixture(
    (_body, turn) =>
      turn === 1
        ? message(call("search", "{}"))
        : message(
            call("search", "{}"),
            call(finalName, '{"summary":"a"}', "final"),
          ),
    async ({ run, bodies, executions, db }: any) => {
      await assert.rejects(run(), /budget exhausted/);
      assert.equal(bodies.length, 2);
      assert.equal(executions(), 1);
      assert.equal(db.get("agent-result", "task"), undefined);
    },
    1,
  );
});

test("research call limit stays separate from output tool and stops paid continuation", async () => {
  await fixture(
    () => message(call("search", "{}"), call("search", "{}", "second")),
    async ({ run, bodies, executions, db }: any) => {
      await assert.rejects(run(), /tool.*limit/i);
      assert.equal(bodies.length, 1);
      assert.equal(executions(), 1);
      assert.equal(db.all("agent-tool-call").length, 2);
    },
    10,
    1,
  );
});

test("malformed final alongside research cannot trigger another research or model call", async () => {
  await fixture(
    () =>
      message(
        call("search", "{}"),
        call(finalName, '{"summary":"bad\\QBTC"}', "final"),
      ),
    async ({ run, bodies, executions, db }: any) => {
      await assert.rejects(run(), (error) => {
        assert.equal(classifyResearchFailure(error), "INVALID_OUTPUT");
        return true;
      });
      assert.equal(bodies.length, 1);
      assert.equal(executions(), 0);
      assert.equal(db.get("agent-result", "task"), undefined);
    },
  );
});

test("invalid second final cannot be discarded in favor of a valid final", async () => {
  await fixture(
    () =>
      message(
        call(finalName, '{"summary":"valid"}'),
        call(finalName, '{"summary":"bad\\QBTC"}', "bad"),
      ),
    async ({ run, bodies, db }: any) => {
      await assert.rejects(run());
      assert.equal(bodies.length, 1);
      assert.equal(db.get("agent-result", "task"), undefined);
    },
  );
});

test("tool output works for no research tools and early research completion", async () => {
  await fixture(
    (_body, turn) =>
      turn === 1
        ? message(call("search", "{}"))
        : message(call(finalName, '{"summary":"done"}')),
    async ({ run, bodies, executions }: any) => {
      assert.equal((await run()).value.summary, "done");
      assert.equal(bodies.length, 2);
      assert.equal(executions(), 1);
      assert.equal((await run("no-research", [])).value.summary, "done");
      assert.equal(bodies[2].response_format, undefined);
      assert.deepEqual(
        bodies[2].tools.map((t: any) => t.function.name),
        [finalName],
      );
    },
  );
});

test("final tool failure advances one bounded attempt with output feedback", async () => {
  await fixture(
    (_body, turn) =>
      turn === 1
        ? message(call(finalName, '{"summary":42}'))
        : message(call(finalName, '{"summary":"done"}')),
    async ({ runtime, db, tools, bodies }: any) => {
      const tasks = new ResearchTasks(db, { maxAttempts: 2 });
      let attempts = 0;
      const result = await tasks.execute(
        "logical",
        ["a"],
        Date.now() + 10000,
        () => {},
        async (agent, id, feedback) => {
          attempts++;
          if (attempts === 2) assert.equal(feedback?.code, "OUTPUT_FORMAT");
          return runtime.run(
            agent,
            id,
            "Research",
            "input",
            tools,
            undefined,
            schema,
          );
        },
      );
      assert.equal(result.value.summary, "done");
      assert.equal(attempts, 2);
      assert.equal(bodies.length, 2);
      assert.equal(
        db.get("research-attempt", "logical:attempt:0").failure,
        "INVALID_OUTPUT",
      );
    },
  );
});

test("immutable context and missing runtime schema remain platform failures", () => {
  for (const message of [
    "Agent request conflict",
    "research attempt context conflict",
    "Agent tool output requires outputSchema",
    "Agent research tool name is reserved for final output",
    "Agent final output tool unavailable",
  ]) {
    assert.equal(classifyResearchFailure(Error(message)), "PLATFORM");
  }
});
