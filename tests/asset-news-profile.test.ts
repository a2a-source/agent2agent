import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { assetNewsTool } from "../src/research-tools.js";

test("test-token news uses explicit underlying markets while retaining test symbols", async () => {
  const search = {
    name: "news_search",
    description: "fixture",
    schema: z.object({ query: z.string() }),
    run: async () => ({ data: [], sources: [], missing: [] }),
  };
  const tool = assetNewsTool(
    [
      { symbol: "QBTC", marketSymbol: "BTCUSDT" },
      { symbol: "QETH", marketSymbol: "ETHUSDT" },
      { symbol: "QBNB", marketSymbol: "BNBUSDT" },
    ],
    search,
    search,
  );
  const output: any = await tool.run({ lookbackDays: 1 });
  assert.deepEqual(
    output.data.map(({ asset, query }: any) => ({ asset, query })),
    [
      { asset: "QBTC", query: "Bitcoin when:1d" },
      { asset: "QETH", query: "Ethereum when:1d" },
      { asset: "QBNB", query: "BNB Chain when:1d" },
    ],
  );
});
