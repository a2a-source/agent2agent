import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { Llm } from "../src/llm.js";
import { loadConfig } from "../src/config.js";
import { deferredPrice, priceQuote } from "./helpers/deferred-price.js";

function fixture() {
  const db = new Store(":memory:");
  const oracle = deferredPrice();
  const llm = new Llm(
    db,
    new Budget(db),
    loadConfig().llm,
    "test",
    oracle.source,
  );
  return { db, llm, ...oracle };
}
test("pending refresh retains only a still-valid cached quote and failure invalidates it", async () => {
  const x = fixture();
  try {
    const initial = x.llm.refreshPrice();
    assert.equal(x.llm.priceReady(), false);
    x.pending[0]!.resolve(priceQuote());
    await initial;
    const refresh = x.llm.refreshPrice();
    assert.equal(x.llm.maximum(), 10000000000000n);
    x.pending[1]!.reject(Error("offline"));
    await assert.rejects(refresh, /offline/);
    assert.equal(x.llm.priceReady(), false);
  } finally {
    x.db.close();
  }
});
test("older refresh completion cannot overwrite a newer quote or undo its failure", async () => {
  const x = fixture();
  try {
    const old = x.llm.refreshPrice(),
      next = x.llm.refreshPrice();
    x.pending[1]!.resolve(priceQuote({ answer: "200000000000" }));
    await next;
    x.pending[0]!.resolve(priceQuote());
    await old;
    assert.equal(x.llm.maximum(), 5000000000000n);
    const older = x.llm.refreshPrice(),
      newer = x.llm.refreshPrice();
    x.pending[3]!.reject(Error("offline"));
    await assert.rejects(newer);
    x.pending[2]!.resolve(priceQuote());
    await older;
    assert.equal(x.llm.priceReady(), false);
    const failed = x.llm.refreshPrice(),
      recovered = x.llm.refreshPrice();
    x.pending[5]!.resolve(priceQuote());
    await recovered;
    x.pending[4]!.reject(Error("old failure"));
    await assert.rejects(failed);
    assert.equal(x.llm.priceReady(), true);
  } finally {
    x.db.close();
  }
});
test("pending refresh does not extend observation or feed age and invalid replacement fails closed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000000 });
  const x = fixture();
  try {
    for (const [quote, elapsed] of [
      [priceQuote(), 60001],
      [priceQuote({ updatedAt: 6100 }), 1000],
    ] as const) {
      const initial = x.llm.refreshPrice();
      x.pending.at(-1)!.resolve(quote);
      await initial;
      const refresh = x.llm.refreshPrice();
      t.mock.timers.tick(elapsed);
      assert.equal(x.llm.priceReady(), false);
      x.pending.at(-1)!.resolve(priceQuote({ answer: "0" }));
      await assert.rejects(refresh, /invalid or stale/);
      assert.equal(x.llm.priceReady(), false);
      t.mock.timers.setTime(10000000);
    }
  } finally {
    x.db.close();
  }
});

test("timed out refresh invalidates cache and late source resolution cannot revive it", async () => {
  const x = fixture();
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const initial = x.llm.refreshPrice();
    x.pending[0]!.resolve(priceQuote());
    await initial;
    x.llm.config.timeoutMs = 5;
    const refresh = x.llm.refreshPrice();
    assert.equal(x.llm.priceReady(), true);
    await assert.rejects(refresh, /oracle unavailable/);
    assert.equal(x.llm.priceReady(), false);
    x.pending[1]!.resolve(priceQuote());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(x.llm.priceReady(), false);
    const recovery = x.llm.refreshPrice();
    x.pending[2]!.resolve(priceQuote());
    await recovery;
    assert.equal(x.llm.priceReady(), true);
  } finally {
    clearInterval(keepAlive);
    x.db.close();
  }
});
