import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, llmHashConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { Llm } from "../src/llm.js";
import { hash } from "../src/protocol.js";
const route = {
  only: ["open-inference/fp4"],
  allowFallbacks: false,
  requireParameters: true,
  maxPrice: { prompt: 0.02, completion: 0.27 },
};
function config(provider: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-provider-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ llm: { provider } }));
    return loadConfig(path).llm;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("provider route validates bounds and defaults without enabling routing by default", () => {
  assert.equal(loadConfig().llm.provider, undefined);
  const ordinary = loadConfig().llm;
  assert.equal(hash(llmHashConfig(ordinary)), hash(ordinary));
  assert.doesNotThrow(() => hash(llmHashConfig(config(route))));
  assert.deepEqual(config({ only: ["relace"] }).provider, {
    only: ["relace"],
    allowFallbacks: false,
    requireParameters: true,
  });
  for (const invalid of [
    { only: [] },
    { only: [""] },
    { only: [" "] },
    { only: Array(33).fill("relace") },
    { only: ["x".repeat(161)] },
    { ...route, maxPrice: { prompt: -1, completion: 0 } },
    { ...route, maxPrice: { prompt: null, completion: 0 } },
    { ...route, order: ["relace"] },
  ])
    assert.throws(() => config(invalid));
});
test("persisted route maps exact API keys, overrides raw policy, binds cache and leaves fixed billing intact", async () => {
  const db = new Store(":memory:");
  try {
    const c = config(route),
      budget = new Budget(db),
      llm = new Llm(db, budget, c, []);
    await assert.rejects(
      llm.chat("a", "one", {
        messages: [],
        provider: { only: ["evil"], sort: "price" },
      }),
      /API key unavailable/,
    );
    const input = db.get<any>("llm-input", "one")!;
    assert.deepEqual(input.payload.provider, {
      only: ["open-inference/fp4"],
      allow_fallbacks: false,
      require_parameters: true,
      max_price: { prompt: 0.02, completion: 0.27 },
    });
    assert.equal(db.get<any>("llm-call", "one").billing, "fixed-request/1");
    const changed = new Llm(
      db,
      budget,
      config({ ...route, only: ["relace"] }),
      [],
    );
    await assert.rejects(
      changed.chat("a", "one", {
        messages: [],
        provider: { only: ["evil"], sort: "price" },
      }),
      /request conflict/,
    );
    await assert.rejects(
      changed.chat("a", "two", { messages: [] }),
      /API key unavailable/,
    );
    assert.notEqual(
      db.get<any>("llm-input", "two").requestHash,
      input.requestHash,
    );
    const ordinaryConfig = loadConfig().llm;
    const ordinary = new Llm(db, budget, ordinaryConfig, []);
    await assert.rejects(
      ordinary.chat("a", "ordinary", { messages: [] }),
      /API key unavailable/,
    );
    assert.equal(
      db.get<any>("llm-input", "ordinary").requestHash,
      hash({
        agent: "a",
        payload: {
          messages: [],
          model: ordinaryConfig.model,
          max_tokens: ordinaryConfig.maxOutputTokens,
          stream: false,
          ...(ordinaryConfig.reasoningEffort
            ? { reasoning: { effort: ordinaryConfig.reasoningEffort } }
            : {}),
        },
        raw: true,
        endpoint: ordinaryConfig.endpoint,
        billing: "fixed-request/1",
      }),
    );
    assert.equal(
      Object.hasOwn(db.get<any>("llm-input", "ordinary").payload, "provider"),
      false,
    );
  } finally {
    db.close();
  }
});
test("provider health circuits cannot cross routing policy identities", async () => {
  const db = new Store(":memory:");
  try {
    const c = loadConfig().llm;
    db.put("provider-circuit", hash({ endpoint: c.endpoint, model: c.model }), {
      failures: 2,
      retryAt: Date.now() + 60000,
    });
    assert.equal(
      await new Llm(db, new Budget(db), c, []).probeProvider(),
      false,
    );
    const routed = config(route);
    assert.equal(
      await new Llm(db, new Budget(db), routed, []).probeProvider(),
      true,
    );
    db.put(
      "provider-circuit",
      hash({
        endpoint: routed.endpoint,
        model: routed.model,
        provider: JSON.stringify(route),
      }),
      { failures: 2, retryAt: Date.now() + 60000 },
    );
    assert.equal(
      await new Llm(db, new Budget(db), routed, []).probeProvider(),
      false,
    );
    assert.equal(
      await new Llm(
        db,
        new Budget(db),
        config({ ...route, only: ["relace"] }),
        [],
      ).probeProvider(),
      true,
    );
  } finally {
    db.close();
  }
});
