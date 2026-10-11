import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AgentRuntime } from "../src/agent-runtime.js";
import { Llm } from "../src/llm.js";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { hash } from "../src/protocol.js";
import { loadConfig } from "./test-config.js";

const call = (name: string, id: string, args = "{}") => ({
  id,
  type: "function",
  function: { name, arguments: args },
});
for (const duplicateBatch of [false, true]) {
  test(`frozen snapshot stays bounded through stale requests and replay (batch=${duplicateBatch})`, async () => {
    const staleRounds = duplicateBatch ? 9 : 6;
    const db = new Store(":memory:");
    const cfg = loadConfig().llm;
    cfg.maxInputBytes = 200000;
    cfg.endpoint = "https://offline.invalid";
    delete cfg.provider;
    delete cfg.reasoningEffort;
    const llm = new Llm(db, new Budget(db), cfg, "offline");
    const chat = llm.chat.bind(llm);
    const bodies: any[] = [];
    // Seed fake provider responses into the real Llm cache, exercising its
    // serialization and byte guard without any provider dispatch or billing.
    llm.chat = async (agent, id, request, signal) => {
      bodies.push(request);
      const turn = Number(id.split(":").at(-1));
      const calls =
        turn < staleRounds
          ? [
              call("research_snapshot", `snapshot-${turn}`),
              ...(turn === 0 && duplicateBatch
                ? [call("research_snapshot", "batch-duplicate")]
                : []),
            ]
          : turn === staleRounds
            ? [call("search", "search")]
            : [
                call(
                  "a2a_final_output",
                  "final",
                  '{"summary":"evidence available"}',
                ),
              ];
      const payload = {
        ...request,
        model: cfg.model,
        max_tokens: cfg.maxOutputTokens,
        stream: false,
      };
      delete (payload as any).max_completion_tokens;
      if (!db.get("llm-call", id))
        db.insert("llm-call", id, {
          status: "DONE",
          requestHash: hash({
            agent,
            payload,
            raw: true,
            endpoint: cfg.endpoint,
            billing: "fixed-request/1",
          }),
          result: {
            choices: [
              {
                index: 0,
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: calls,
                },
              },
            ],
          },
        });
      return chat(agent, id, request, signal);
    };
    let snapshots = 0,
      searches = 0;
    const frozen = { evidence: "e".repeat(28400) };
    const tools = [
      {
        name: "research_snapshot",
        description: "Frozen snapshot",
        schema: z.object({}),
        run: async () => {
          snapshots++;
          return frozen;
        },
      },
      {
        name: "search",
        description: "Different evidence",
        schema: z.object({}),
        run: async () => {
          searches++;
          return { found: true };
        },
      },
    ];
    const runtime = new AgentRuntime(llm, {
      maxToolRounds: 10,
      maxToolCalls: 20,
      finalOutputMode: "tool",
    });
    const run = () =>
      runtime.run(
        "a",
        "attempt",
        "Research",
        "c".repeat(38000),
        tools,
        undefined,
        {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
      );
    try {
      const result = await run();
      assert.equal(snapshots, 1);
      assert.equal(searches, 1);
      assert.deepEqual(result.value, { summary: "evidence available" });
      assert.deepEqual(
        result.observations.map((o) => o.tool),
        ["research_snapshot", "search"],
      );
      assert.equal(bodies.length, staleRounds + 2);
      assert.ok(
        bodies
          .at(-1)
          .tools.some((t: any) => t.function.name === "a2a_final_output"),
      );
      if (duplicateBatch) {
        assert.deepEqual(
          bodies.at(-1).tools.map((t: any) => t.function.name),
          ["a2a_final_output"],
        );
      }
      for (const body of bodies.slice(1, staleRounds + 1)) {
        assert.deepEqual(body.tools.map((t: any) => t.function.name).sort(), [
          "a2a_final_output",
          "search",
        ]);
        assert.equal(
          body.messages.filter(
            (m: any) =>
              m.role === "tool" && m.content === JSON.stringify(frozen),
          ).length,
          1,
        );
        assert.ok(Buffer.byteLength(JSON.stringify(body)) < 200000);
      }
      for (const id of [
        ...Array.from(
          { length: staleRounds - 1 },
          (_, i) => `snapshot-${i + 1}`,
        ),
        ...(duplicateBatch ? ["batch-duplicate"] : []),
      ]) {
        const blocked = bodies[staleRounds + 1].messages.find(
          (m: any) => m.role === "tool" && m.tool_call_id === id,
        );
        assert.match(blocked.content, /limit exceeded.*research_snapshot/);
        assert.ok(
          bodies[staleRounds + 1].messages.some(
            (m: any) =>
              m.role === "assistant" &&
              m.tool_calls?.some((c: any) => c.id === id),
          ),
        );
      }
      assert.equal(db.all("agent-tool-call").length, 2);
      db.remove("agent-result", "attempt");
      assert.deepEqual(await run(), result);
      assert.equal(snapshots, 1);
      assert.equal(searches, 1);
      assert.equal(db.all("agent-tool-call").length, 2);
    } finally {
      db.close();
    }
  });
}
