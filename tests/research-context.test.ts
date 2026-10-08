import { test } from "node:test";
import assert from "node:assert/strict";
import {
  portfolioSnapshot,
  marketMetrics,
  compareContext,
} from "../src/research-context.js";
const asset = {
  symbol: "ETH",
  address: "0x0000000000000000000000000000000000000001",
  decimals: 18,
  marketSymbol: "ETHUSDT",
};
test("known balances distinguish empty, unknown cost and known PnL without treating deposits as profit", () => {
  const empty = portfolioSnapshot(
    [{ ...asset, quantity: "0", priceMicros: "2000000000", costMicros: null }],
    true,
  );
  assert.equal(empty.status, "EMPTY");
  assert.equal(empty.valueMicros, "0");
  assert.equal(empty.returnBps, null);
  const funded = portfolioSnapshot(
    [
      {
        ...asset,
        quantity: "1000000000000000000",
        priceMicros: "2000000000",
        costMicros: null,
      },
    ],
    true,
  );
  assert.equal(funded.valueMicros, "2000000000");
  assert.equal(funded.unrealizedPnlMicros, null);
  const known = portfolioSnapshot(
    [
      {
        ...asset,
        quantity: "1000000000000000000",
        priceMicros: "2000000000",
        costMicros: "1000000000",
      },
    ],
    true,
  );
  assert.equal(known.unrealizedPnlMicros, "1000000000");
  assert.equal(known.returnBps, 10000);
  assert.equal(portfolioSnapshot([], false).status, "UNKNOWN");
  const d = compareContext(
    { portfolio: empty, markets: [] },
    { portfolio: funded, markets: [] },
  );
  assert.equal(d.portfolioValueDeltaMicros, "2000000000");
  assert.equal(d.investmentReturnBps, null);
  assert.match(d.returnMissing, /cashflow/);
});
test("market metrics are deterministic and reject nonmonotonic candles", () => {
  const candles = Array.from({ length: 24 }, (_, i) => ({
    closeTime: 1000 + i * 60000,
    closeMicros: String(1000000 + i * 1000),
  }));
  assert.equal(marketMetrics(candles).changeBps, 230);
  assert.throws(() => marketMetrics([...candles, candles[0]!]));
});
import { evidence, normalizeEvidence } from "../src/research-context.js";
import { hash } from "../src/protocol.js";
test("decimal provider numbers have stable evidence hashes without changing protocol integer rules", () => {
  const raw = { liquidity: { usd: 123.45 }, optional: undefined };
  const e = evidence("dex", "https://example.com", null, raw, 1);
  assert.equal(e.contentHash, hash(normalizeEvidence(raw)));
  assert.equal((normalizeEvidence(raw) as any).liquidity.usd, "123.45");
});
test("portfolio identity or universe change resets comparison baseline", () => {
  const p = portfolioSnapshot(
    [
      {
        ...asset,
        quantity: "1000000000000000000",
        priceMicros: "1000000",
        costMicros: null,
      },
    ],
    true,
  );
  const prev = {
    portfolio: p,
    markets: [],
    chainId: 56,
    universe: [asset],
    portfolioIdentity: {
      wallet: "0xabc",
      scope: "CONFIGURED_ASSETS_AND_NATIVE",
    },
  };
  for (const change of [
    {
      portfolioIdentity: {
        wallet: "0xdef",
        scope: "CONFIGURED_ASSETS_AND_NATIVE",
      },
    },
    { chainId: 97 },
    { universe: [] },
  ]) {
    const d = compareContext(prev, { ...prev, ...change });
    assert.equal(d.portfolioValueDeltaMicros, null);
    assert.deepEqual(d.positions, []);
    assert.match(d.returnMissing, /baseline/);
  }
});
import { promptSnapshot } from "../src/research-context.js";
test("model context renders reference prices and basis points without scale ambiguity", () => {
  const raw: any = {
    at: 1,
    universe: [],
    portfolio: portfolioSnapshot([], true),
    markets: [
      {
        ...asset,
        priceMicros: "2565080000",
        smaMicros: "2564039000",
        changeBps: 22,
        volatilityBps: 11,
        asOf: 1,
        evidenceId: "m",
        samples: 60,
      },
    ],
    evidence: [{ id: "m", kind: "market", asOf: 1 }],
    news: [
      {
        title: "Policy",
        url: "https://example.com/policy",
        publishedAt: 1,
        evidenceId: "m",
      },
    ],
    liquidity: [],
    changes: { positions: [], prices: [] },
    policy: { maxAssetBps: 3000, maxTotalBps: 8000 },
    missing: [],
    previous: null,
  };
  const p: any = promptSnapshot(raw);
  assert.equal(p.markets[0].priceUSDT, "2565.08");
  assert.equal(p.markets[0].changePercent, "0.22");
  assert.equal(p.markets[0].smaUSDT, "2564.039");
  assert.equal(p.markets[0].priceVsSma, "ABOVE");
  assert.equal(p.markets[0].smaDeviationPercent, "0.04");
  assert.equal(p.news[0].url, "https://example.com/policy");
  assert.equal(p.facts.totalTokens.limitPercent, "80.0");
  assert.equal(p.news[0].verification, "HEADLINE_ONLY");
  assert.equal(p.news[0].publishedAtISO, "1970-01-01T00:00:00.001Z");
  for (const publishedAt of [null, 1e20])
    assert.equal(
      promptSnapshot({ ...raw, news: [{ ...raw.news[0], publishedAt }] })
        .news[0]!.publishedAtISO,
      null,
    );
  assert.deepEqual(promptSnapshot(raw, "onchain").news, []);
  assert.equal(
    raw.news.length,
    1,
    "role filtering must not mutate the signed context",
  );
});
