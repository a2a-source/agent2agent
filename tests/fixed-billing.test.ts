import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { Llm } from "../src/llm.js";
import { loadConfig } from "../src/config.js";
async function fixture(reply: (res: any, n: number) => void) {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => reply(res, ++calls));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const db = new Store(":memory:"),
    budget = new Budget(db),
    c = loadConfig().llm;
  c.endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  (c as any).bnbUsdMicros = "1000000000";
  budget.credit("a", "test", 1000000000000000n);
  return {
    db,
    budget,
    c,
    calls: () => calls,
    close: async () => {
      db.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
test("each dispatched completion costs USD0.01 without requiring usage; cache is free", async () => {
  const f = await fixture((res) =>
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
    ),
  );
  try {
    const llm = new Llm(f.db, f.budget, f.c, "test");
    assert.equal(llm.maximum(), 10000000000000n);
    assert.equal((await llm.call("a", "one", "s", "i")).ok, true);
    assert.equal(f.budget.available("a"), 990000000000000n);
    assert.equal(f.budget.account("a").reserved, "0");
    await llm.call("a", "one", "s", "i");
    assert.equal(f.calls(), 1);
    const rows = f.db.all<any>("llm-request");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].usdMicros, "10000");
    assert.equal(rows[0].costWei, "10000000000000");
  } finally {
    await f.close();
  }
});
test("429 rotation charges each physical request and request-cap rejection is free", async () => {
  const f = await fixture((res, n) => {
    res.statusCode = n === 1 ? 429 : 200;
    res.end(
      n === 1
        ? "{}"
        : JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
          }),
    );
  });
  try {
    f.c.requestLimitPerDay = 2;
    const llm = new Llm(f.db, f.budget, f.c, "one\ntwo");
    assert.equal((await llm.call("a", "one", "s", "i")).ok, true);
    assert.equal(f.budget.available("a"), 980000000000000n);
    await assert.rejects(llm.call("a", "cap", "s", "i"), /request limit/);
    assert.equal(f.calls(), 2);
    assert.equal(f.db.all("llm-request").length, 2);
    assert.equal(f.budget.account("a").reserved, "0");
  } finally {
    await f.close();
  }
});
test("provider errors and malformed output consume one fixed fee without uncertain money holds", async () => {
  const f = await fixture((res, n) =>
    res.end(
      n === 1
        ? JSON.stringify({ error: { code: 503 } })
        : JSON.stringify({ choices: [{ message: { content: "broken" } }] }),
    ),
  );
  try {
    const llm = new Llm(f.db, f.budget, f.c, "one");
    await assert.rejects(llm.call("a", "error", "s", "i"), /503/);
    await assert.rejects(llm.call("a", "bad", "s", "i"));
    assert.equal(f.budget.available("a"), 980000000000000n);
    assert.equal(f.budget.account("a").reserved, "0");
    const restarted = new Llm(f.db, f.budget, f.c, "one");
    await assert.rejects(restarted.call("a", "error", "s", "i"), /uncertain/);
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});
test("pre-dispatch cancellation and missing conversion rate cannot debit or call provider", async () => {
  const f = await fixture((res) => res.end("{}"));
  try {
    const llm = new Llm(f.db, f.budget, f.c, "one");
    await assert.rejects(
      llm.call(
        "a",
        "abort",
        "s",
        "i",
        AbortSignal.abort(new Error("cancelled")),
      ),
      /cancelled/,
    );
    (f.c as any).bnbUsdMicros = "0";
    await assert.rejects(llm.call("a", "price", "s", "i"), /BNB\/USD/);
    assert.equal(f.calls(), 0);
    assert.equal(f.budget.available("a"), 1000000000000000n);
  } finally {
    await f.close();
  }
});

test("failed dispatch journal transaction rolls back fee, counter and reservation before HTTP", async () => {
  const f = await fixture((res) => res.end("{}"));
  try {
    const insert = f.db.insert.bind(f.db);
    f.db.insert = ((kind: string, id: string, data: unknown) => {
      if (kind === "llm-request") throw Error("injected journal write failure");
      insert(kind, id, data);
    }) as typeof f.db.insert;
    const llm = new Llm(f.db, f.budget, f.c, "one");
    await assert.rejects(llm.call("a", "atomic", "s", "i"), /journal write/);
    assert.equal(f.calls(), 0);
    assert.equal(f.budget.available("a"), 1000000000000000n);
    assert.equal(f.budget.account("a").reserved, "0");
    assert.equal(f.db.all("llm-request-count").length, 0);
    assert.equal(f.db.all("reservation").length, 0);
  } finally {
    await f.close();
  }
});
test("insufficient funds cannot dispatch or advance daily quota", async () => {
  const f = await fixture((res) => res.end("{}"));
  try {
    const llm = new Llm(f.db, f.budget, f.c, "one");
    await assert.rejects(
      llm.call("unfunded", "no-funds", "s", "i"),
      /insufficient compute/,
    );
    assert.equal(f.calls(), 0);
    assert.equal(f.db.all("llm-request-count").length, 0);
    assert.equal(f.db.all("reservation").length, 0);
  } finally {
    await f.close();
  }
});
test("a new runtime cannot replay an in-flight paid request", async () => {
  let notify!: () => void;
  const arrived = new Promise<void>((r) => (notify = r));
  const f = await fixture(() => notify());
  const controller = new AbortController();
  try {
    const llm = new Llm(f.db, f.budget, f.c, "one");
    const running = llm.call("a", "in-flight", "s", "i", controller.signal);
    const rejected = assert.rejects(running, /cancelled/);
    await arrived;
    assert.equal(f.db.get<any>("llm-call", "in-flight").status, "IN_FLIGHT");
    await assert.rejects(
      new Llm(f.db, f.budget, f.c, "one").call("a", "in-flight", "s", "i"),
      /uncertain/,
    );
    assert.equal(f.calls(), 1);
    assert.equal(f.budget.available("a"), 990000000000000n);
    assert.equal(f.budget.account("a").reserved, "0");
    controller.abort(new Error("cancelled"));
    await rejected;
  } finally {
    controller.abort();
    await f.close();
  }
});
test("legacy settlements and holds stay unchanged while new requests use fixed pricing", async () => {
  const f = await fixture((res) =>
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
    ),
  );
  try {
    f.budget.reserve("a", "legacy-hold", 80n);
    f.budget.unknown("legacy-hold");
    f.budget.reserve("a", "legacy-done", 80n);
    f.budget.settle("legacy-done", 40n);
    f.db.put("llm-call", "legacy-done", {
      requestHash: "legacy-hash",
      status: "DONE",
      cost: "40",
    });
    const before = f.db.all("reservation");
    const llm = new Llm(f.db, f.budget, f.c, "one");
    await assert.rejects(llm.call("a", "legacy-done", "s", "i"), /conflict/);
    await llm.call("a", "new", "s", "i");
    for (const prior of before as any[])
      assert.deepEqual(f.db.get("reservation", prior.id), prior);
    assert.equal(f.db.get<any>("llm-call", "legacy-done").cost, "40");
    assert.equal(f.budget.account("a").reserved, "80");
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});
test("BNB conversion rounds up one request fee using integer arithmetic", async () => {
  const f = await fixture((res) => res.end("{}"));
  try {
    f.c.bnbUsdMicros = "3000000000";
    assert.equal(new Llm(f.db, f.budget, f.c, "one").maximum(), 3333333333334n);
  } finally {
    await f.close();
  }
});
test("fresh onchain quote for each dispatch; invalid quote fails closed and can recover", async () => {
  const f = await fixture((res) =>
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
    ),
  );
  let answer = "100000000000",
    reads = 0,
    invalid = false;
  const source = {
    maxAgeSeconds: 3900,
    async quote() {
      reads++;
      if (invalid) throw Error("BNB/USD oracle unavailable");
      return {
        answer,
        decimals: 8,
        roundId: String(reads),
        answeredInRound: String(reads),
        updatedAt: Math.floor(Date.now() / 1000),
        blockNumber: 100 + reads,
        blockHash: "0xabc",
        chainId: 97,
        feed: "test-feed",
        observedAt: Date.now(),
      };
    },
  };
  try {
    const llm = new Llm(f.db, f.budget, f.c, "test", source);
    assert.equal(llm.priceReady(), false);
    await llm.call("a", "chain-1", "s", "i");
    answer = "200000000000";
    await llm.call("a", "chain-2", "s", "i");
    const rows = f.db.all<any>("llm-request");
    assert.deepEqual(
      rows.map((r) => r.costWei),
      ["10000000000000", "5000000000000"],
    );
    assert.deepEqual(
      rows.map((r) => r.priceQuote.roundId),
      ["1", "2"],
    );
    assert.equal(rows[0].bnbUsdMicros, undefined);
    await llm.call("a", "chain-2", "s", "i");
    assert.equal(reads, 2);
    invalid = true;
    await assert.rejects(llm.call("a", "chain-3", "s", "i"), /oracle/);
    assert.equal(f.calls(), 2);
    assert.equal(llm.priceReady(), false);
    assert.equal(f.db.all("llm-request").length, 2);
    invalid = false;
    await llm.refreshPrice();
    assert.equal(llm.priceReady(), true);
  } finally {
    await f.close();
  }
});
test("oracle wait crossing UTC midnight charges the dispatch day quota", async (t) => {
  const f = await fixture((res) =>
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
    ),
  );
  const start = Date.parse("2026-10-07T23:59:59Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const source = {
    maxAgeSeconds: 3900,
    async quote() {
      t.mock.timers.setTime(start + 2000);
      return {
        answer: "100000000000",
        decimals: 8,
        roundId: "1",
        answeredInRound: "1",
        updatedAt: Math.floor(Date.now() / 1000),
        blockNumber: 1,
        blockHash: "0xabc",
        chainId: 97,
        feed: "test",
        observedAt: Date.now(),
      };
    },
  };
  try {
    const llm = new Llm(f.db, f.budget, f.c, "test", source);
    await llm.call("a", "midnight", "s", "i");
    const rows = f.db.entries<any>("llm-request-count");
    assert.equal(rows.length, 1);
    assert(rows[0]!.id.endsWith(":2026-10-08"));
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});
