import type { PriceQuote, PriceSource } from "../../src/price.js";
export function priceQuote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    answer: "100000000000",
    decimals: 8,
    roundId: "1",
    answeredInRound: "1",
    updatedAt: Math.floor(Date.now() / 1000),
    observedAt: Date.now(),
    blockNumber: 100,
    blockHash: "0x" + "aa".repeat(32),
    chainId: 56,
    feed: "0x" + "33".repeat(20),
    ...overrides,
  };
}
export function deferredPrice() {
  const pending: {
    resolve: (q: PriceQuote) => void;
    reject: (e: Error) => void;
  }[] = [];
  const source: PriceSource = {
    maxAgeSeconds: 3900,
    quote: () =>
      new Promise<PriceQuote>((resolve, reject) =>
        pending.push({ resolve, reject }),
      ),
  };
  return { source, pending };
}
