import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCandles, parseLiquidity } from "../src/research-data.js";
test("candle adapter excludes open candles and rejects stale data; DEX asset binding enforced", () => {
  const now = 1800000000000;
  const rows = Array.from({ length: 61 }, (_, i) => [
    now - (61 - i) * 60000,
    "1",
    "1",
    "1",
    "1",
    "1",
    now - (60 - i) * 60000 - 1,
  ]);
  assert.equal(parseCandles(rows, now, 120000).candles.length, 60);
  assert.throws(() => parseCandles(rows, now + 300000, 120000), /stale/);
  const address = "0x0000000000000000000000000000000000000001";
  assert.equal(
    parseLiquidity(
      [
        {
          chainId: "ethereum",
          baseToken: { address },
          liquidity: { usd: 10000 },
        },
      ],
      address,
    ).length,
    0,
  );
  assert.equal(
    parseLiquidity(
      [
        {
          chainId: "bsc",
          baseToken: { address: "other" },
          liquidity: { usd: 10000 },
        },
      ],
      address,
    ).length,
    0,
  );
});
import { assertResearchAssets } from "../src/research-context.js";
import { loadConfig } from "./test-config.js";
test("reference market symbols cannot price arbitrary contracts or wrong-chain copies", () => {
  const c = loadConfig();
  assertResearchAssets(c.research.chainId, c.research.assets);
  assert.throws(
    () => assertResearchAssets(97, c.research.assets),
    /asset registry/,
  );
  assert.throws(
    () =>
      assertResearchAssets(56, [
        { ...c.research.assets[0]!, address: c.research.assets[1]!.address },
      ]),
    /asset registry/,
  );
});
import { parseNews } from "../src/research-tools.js";
test("official RSS CDATA links and titles retain dated macro evidence", () => {
  const rows = parseNews(
    "<rss><item><title><![CDATA[Policy release]]></title><link><![CDATA[https://www.federalreserve.gov/newsevents/pressreleases/test.htm]]></link><pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate></item></rss>",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, "Policy release");
  assert.equal(rows[0]!.publishedAt, 1791374400000);
});
