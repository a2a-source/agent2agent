import { test } from "node:test";
import assert from "node:assert/strict";
import { marketKlinesTool } from "../src/market-klines.js";
import { contextTools } from "../src/research-data.js";
const now = 1800000000000;
const rows = () =>
  Array.from({ length: 4 }, (_, i) => [
    now - (3 - i) * 60000,
    "100.00000001",
    "102",
    "99",
    "101",
    "3.5",
    now - (2 - i) * 60000 - 1,
    "353.5",
    7,
  ]);
test("klines retains exact OHLCV, excludes open bar and bounds official request", async () => {
  let url = "";
  const t = marketKlinesTool(
    async (u) => {
      url = u;
      return rows();
    },
    () => now,
  );
  const out: any = await t.run({ symbol: "BTCUSDT", interval: "1m", limit: 3 });
  assert.equal(new URL(url).origin, "https://data-api.binance.vision");
  assert.equal(new URL(url).searchParams.get("limit"), "4");
  assert.equal(out.data.candles.length, 3);
  assert.equal(out.data.candles[0].open, "100.00000001");
  assert.equal(out.data.candles[0].volume, "3.5");
  assert(out.data.candles.every((c: any) => c.closeTime < now));
  assert.equal(out.sources[0].publishedAt, now - 1);
});
test("klines rejects unsupported inputs before fetching", async () => {
  let calls = 0;
  const t = marketKlinesTool(
    async () => {
      calls++;
      return rows();
    },
    () => now,
  );
  for (const input of [
    { symbol: "EVILUSDT" },
    { symbol: "BTCUSDT", interval: "1s" },
    { symbol: "BTCUSDT", limit: 101 },
    { symbol: "BTCUSDT", url: "https://example.com" },
  ])
    await assert.rejects(() => t.run(input));
  assert.equal(calls, 0);
});
test("klines marks stale, discontinuous, malformed and unavailable responses missing", async () => {
  const gap = rows();
  gap[1]![0] = Number(gap[1]![0]) - 60000;
  const bad = rows();
  bad[0]![2] = "98";
  for (const raw of [
    gap,
    bad,
    [],
    { code: -1 },
    rows().map((r) =>
      r.map((x, i) => (i === 0 || i === 6 ? Number(x) - 300000 : x)),
    ),
  ]) {
    const out: any = await marketKlinesTool(
      async () => raw,
      () => now,
    ).run({ symbol: "ETHUSDT", limit: 3 });
    assert.equal(out.data, null);
    assert(out.missing.length);
  }
  const out: any = await marketKlinesTool(async () => {
    throw Error("provider failure");
  }).run({ symbol: "BNBUSDT" });
  assert.equal(out.data, null);
});
test("klines propagates cancellation and registers only for market role", async () => {
  const c = new AbortController();
  c.abort(Error("cancelled"));
  await assert.rejects(
    () =>
      marketKlinesTool(async () => rows()).run({ symbol: "BTCUSDT" }, c.signal),
    /cancelled/,
  );
  for (const role of [
    "positions",
    "macro",
    "news",
    "risk",
    "onchain",
    "market",
  ]) {
    const tools = contextTools({} as any, role);
    assert.equal(
      tools.some((t) => t.name === "market_klines"),
      role === "market",
    );
  }
});
test("klines supports every advertised UTC interval and marks partial history", async () => {
  for (const [interval, step] of Object.entries({
    "1m": 60000,
    "5m": 300000,
    "15m": 900000,
    "1h": 3600000,
    "4h": 14400000,
    "1d": 86400000,
  })) {
    const boundary = Math.floor(now / step) * step;
    const raw = [
      [boundary - step, "1", "2", "1", "2", "0", boundary - 1, "0", 0],
    ];
    const out: any = await marketKlinesTool(
      async () => raw,
      () => boundary + 1000,
    ).run({ symbol: "BNBUSDT", interval, limit: 2 });
    assert.equal(out.data.interval, interval);
    assert.equal(out.data.candles.length, 1);
    assert.equal(out.missing.length, 1);
  }
});
