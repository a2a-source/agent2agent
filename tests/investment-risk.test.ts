import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { InvestmentRisk } from "../src/investment-risk.js";
const wallet = "0x0000000000000000000000000000000000000001";
const snapshot = () => ({
  epoch: "e1",
  agent: "a1",
  wallet,
  chainId: 56,
  at: 1000,
  validUntil: 60000,
  complete: true,
  navMicros: "1000000000",
  stableValueMicros: "1000000000",
  availableStableMicros: "1000000000",
  exposures: { BTC: "0", ETH: "0", BNB: "0" },
});
const order = (id = "o1", amount = "50000000") => ({
  id,
  side: "BUY",
  bucket: "BTC",
  notionalMicros: amount,
  gasMicros: "10000",
  slippageBps: 50,
  priceImpactBps: 50,
  quoteAt: 1000,
});
test("10% cycle buy limit survives splitting, replay and service restart", () => {
  const db = new Store(":memory:");
  try {
    const r = new InvestmentRisk(db);
    const cycle = r.open(snapshot());
    const one = r.reserve(cycle.id, order(), 1100, true);
    assert.deepEqual(r.reserve(cycle.id, order(), 1200, true), one);
    const restarted = new InvestmentRisk(db);
    restarted.reserve(cycle.id, order("o2"), 1200, true);
    assert.throws(
      () => restarted.reserve(cycle.id, order("o3", "10000000"), 1200, true),
      /cycle buy/,
    );
    assert.throws(
      () => r.open({ ...snapshot(), availableStableMicros: "900000000" }),
      /conflict/,
    );
    assert.throws(
      () =>
        r.reserve(
          cycle.id,
          { ...order(), notionalMicros: "60000000" },
          1200,
          true,
        ),
      /conflict/,
    );
  } finally {
    db.close();
  }
});
test("total60%, underlying20%, pending buys and BNB shared bucket are enforced", () => {
  const db = new Store(":memory:");
  try {
    const r = new InvestmentRisk(db),
      s = snapshot();
    s.stableValueMicros = "410000000";
    s.availableStableMicros = "410000000";
    s.exposures = { BTC: "200000000", ETH: "200000000", BNB: "190000000" };
    const c = r.open(s);
    assert.throws(
      () => r.reserve(c.id, order("large", "20000000"), 1100, true),
      /exposure/,
    );
    assert.throws(
      () => r.reserve(c.id, order("btc", "10000000"), 1100, true),
      /exposure/,
    );
    r.reserve(c.id, { ...order("bnb", "10000000"), bucket: "BNB" }, 1100, true);
    assert.throws(
      () =>
        r.reserve(
          c.id,
          { ...order("bnb2", "10000000"), bucket: "BNB" },
          1100,
          true,
        ),
      /exposure/,
    );
  } finally {
    db.close();
  }
});
test("ineligible worker cannot BUY but bounded reductions remain possible without10% buy cap", () => {
  const db = new Store(":memory:");
  try {
    const r = new InvestmentRisk(db),
      s = snapshot();
    s.stableValueMicros = "100000000";
    s.availableStableMicros = "100000000";
    s.exposures = { BTC: "900000000", ETH: "0", BNB: "0" };
    const c = r.open(s);
    assert.throws(
      () => r.reserve(c.id, order("buy", "10000000"), 1100, false),
      /Worker/,
    );
    r.reserve(
      c.id,
      { ...order("sell", "800000000"), side: "SELL" },
      1100,
      false,
    );
    assert.throws(
      () =>
        r.reserve(
          c.id,
          { ...order("sell2", "200000000"), side: "SELL" },
          1100,
          false,
        ),
      /sale/,
    );
    assert.throws(
      () =>
        r.reserve(
          c.id,
          { ...order("buy2", "10000000"), bucket: "ETH" },
          1100,
          true,
        ),
      /exposure/,
    );
  } finally {
    db.close();
  }
});
test("fees, dust, quotes, stale cycles and incomplete/mismatched valuations fail closed", () => {
  const db = new Store(":memory:");
  try {
    const r = new InvestmentRisk(db),
      c = r.open(snapshot());
    for (const change of [
      { notionalMicros: "9999999" },
      { gasMicros: "250001" },
      { slippageBps: 51 },
      { priceImpactBps: 51 },
      { quoteAt: 1101 },
      { notionalMicros: "-1" },
    ])
      assert.throws(() =>
        r.reserve(c.id, { ...order(), ...change }, 1100, true),
      );
    assert.throws(() => r.reserve(c.id, order(), 31000, true));
    assert.throws(() =>
      r.reserve(c.id, { ...order(), quoteAt: 60000 }, 60000, true),
    );
    assert.throws(() =>
      r.open({ ...snapshot(), epoch: "bad", complete: false }),
    );
    assert.throws(() =>
      r.open({ ...snapshot(), epoch: "bad", navMicros: "1000000001" }),
    );
    assert.equal(db.all("investment-risk-order").length, 0);
  } finally {
    db.close();
  }
});
