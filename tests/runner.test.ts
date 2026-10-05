import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Llm } from "../src/llm.js";
import { qspSchema } from "../src/qsp.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
test("compatible LLM calls settle actual usage and ambiguous failures retain reservation", async () => {
  let failure = false;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (failure) {
        res.statusCode = 503;
        res.end("{}");
      } else
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"summary":"evidence","sources":[],"missing":[]}',
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }),
        );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as any;
  const db = new Store(":memory:"),
    budget = new Budget(db);
  budget.credit("a", "fund", 100000n);
  const cfg = loadConfig();
  cfg.llm.endpoint = `http://127.0.0.1:${address.port}`;
  cfg.llm.inputWeiPerMillion = "1000000";
  cfg.llm.outputWeiPerMillion = "2000000";
  cfg.llm.maxInputBytes = 1000;
  cfg.llm.maxOutputTokens = 100;
  const llm = new Llm(db, budget, cfg.llm, "key");
  try {
    const report = await llm.call("a", "one", "system", "input");
    assert.equal(report.summary, "evidence");
    assert.equal(budget.available("a"), 99960n);
    failure = true;
    await assert.rejects(llm.call("a", "two", "system", "input"), /503/);
    assert.ok(budget.available("a") < 99960n);
    const before = budget.available("a");
    await assert.rejects(llm.call("a", "two", "system", "input"), /uncertain/);
    assert.equal(budget.available("a"), before);
  } finally {
    db.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("QSP rejects unbounded positions, floats, wrong assets and missing evidence", () => {
  const valid = {
    version: "a2a-qsp/1",
    epoch: "1",
    view: 0,
    master: "a",
    committeeHash: "h",
    configHash: "c",
    dataAt: 1,
    reports: [
      {
        role: "risk",
        agent: "b",
        summary: "none",
        sources: [],
        missing: ["market"],
      },
    ],
    signals: [],
    risks: ["no data"],
    executed: false,
  };
  assert.equal(qspSchema.parse(valid).executed, false);
  assert.throws(() => qspSchema.parse({ ...valid, executed: true }));
  assert.throws(() =>
    qspSchema.parse({
      ...valid,
      signals: [
        {
          chainId: 56,
          asset: "bad",
          action: "BUY",
          allocationBps: 10001,
          rationale: "x",
          evidence: [],
        },
      ],
    }),
  );
});
test("source adapters reject stale or undated market data instead of stamping it fresh", async () => {
  const { loadSource } = await import("../src/sources.js");
  let data: any = { asOf: 100, data: { price: "1" } };
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal((await loadSource(url, 10000, 1000)).missing, true);
    data = { data: { price: "2" } };
    assert.equal((await loadSource(url, 10000, 1000)).missing, true);
    data = { asOf: 9500, data: { price: "3" } };
    const source = await loadSource(url, 10000, 1000);
    assert.equal(source.at, 9500);
    assert.equal(source.missing, false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
