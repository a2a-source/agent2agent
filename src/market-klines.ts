import { z } from "zod";
import { parseUnits, formatUnits } from "ethers";
import type { ResearchTool } from "./agent-runtime.js";
import { networkFetch } from "./network.js";
import { readJson } from "./http.js";
const durations = {
  "1m": 60000,
  "5m": 300000,
  "15m": 900000,
  "1h": 3600000,
  "4h": 14400000,
  "1d": 86400000,
};
const schema = z
  .object({
    symbol: z.enum(["BTCUSDT", "ETHUSDT", "BNBUSDT"]),
    interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("1h"),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
const decimal = z
  .string()
  .max(64)
  .regex(/^\d+(\.\d{1,18})?$/);
const timestamp = z.number().int().safe().nonnegative();
async function get(url: string, signal?: AbortSignal): Promise<unknown> {
  const r = await networkFetch(url, {
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!r.ok) {
    await r.body?.cancel();
    throw Error("market provider unavailable");
  }
  return readJson(r, 512000);
}
/** Fixed public exchange endpoint; no model-supplied URL or trading credentials. */
export function marketKlinesTool(load = get, clock = Date.now): ResearchTool {
  return {
    name: "market_klines",
    description:
      "Fetch latest closed Binance spot OHLCV candles for BTCUSDT, ETHUSDT or BNBUSDT. Choose interval and 1-100 bars. Prices are exact USDT decimal strings, volume is base-asset quantity. Supplemental reference data, not DEX quotes or a replacement for frozen round context.",
    schema,
    run: async (input, signal) => {
      const { symbol, interval, limit } = schema.parse(input);
      signal?.throwIfAborted();
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit + 1}`;
      try {
        const raw = await load(url, signal),
          retrievedAt = clock(),
          step = durations[interval];
        signal?.throwIfAborted();
        const rows = z
          .array(z.array(z.unknown()).min(9))
          .min(1)
          .max(101)
          .parse(raw);
        const all = rows.map((r) => {
          const c = {
            openTime: timestamp.parse(r[0]),
            open: decimal.parse(r[1]),
            high: decimal.parse(r[2]),
            low: decimal.parse(r[3]),
            close: decimal.parse(r[4]),
            volume: decimal.parse(r[5]),
            closeTime: timestamp.parse(r[6]),
            quoteVolume: decimal.parse(r[7]),
            trades: timestamp.parse(r[8]),
          };
          const [o, h, l, v] = [c.open, c.high, c.low, c.close].map((s) =>
            parseUnits(s, 18),
          );
          if (
            l! <= 0n ||
            h! < l! ||
            o! < l! ||
            o! > h! ||
            v! < l! ||
            v! > h! ||
            c.closeTime !== c.openTime + step - 1 ||
            c.openTime % step !== 0 ||
            c.openTime > retrievedAt
          )
            throw Error("invalid candle");
          return c;
        });
        for (let i = 1; i < all.length; i++)
          if (all[i]!.openTime - all[i - 1]!.openTime !== step)
            throw Error("discontinuous candles");
        const candles = all
            .filter((c) => c.closeTime < retrievedAt)
            .slice(-limit),
          last = candles.at(-1);
        if (!last || retrievedAt - last.closeTime > step + 60000)
          throw Error("stale candles");
        const first = candles[0]!,
          firstOpen = parseUnits(first.open, 18),
          firstClose = parseUnits(first.close, 18),
          lastClose = parseUnits(last.close, 18);
        const average =
          candles.reduce((sum, c) => sum + parseUnits(c.close, 18), 0n) /
          BigInt(candles.length);
        const change = (end: bigint, start: bigint) => {
          const n = ((end - start) * 10000n) / start;
          return n > BigInt(Number.MAX_SAFE_INTEGER) ||
            n < BigInt(Number.MIN_SAFE_INTEGER)
            ? null
            : Number(n);
        };
        return {
          data: {
            exchange: "binance",
            market: "spot",
            symbol,
            interval,
            quoteCurrency: "USDT",
            closedOnly: true,
            asOf: last.closeTime,
            metrics: {
              firstOpenTime: first.openTime,
              firstCloseTime: first.closeTime,
              lastCloseTime: last.closeTime,
              firstOpen: first.open,
              firstClose: first.close,
              lastClose: last.close,
              firstOpenToLastCloseBps: change(lastClose, firstOpen),
              closeToCloseChangeBps: change(lastClose, firstClose),
              smaClose: formatUnits(average, 18),
              lastCloseVsSma:
                lastClose > average
                  ? "ABOVE"
                  : lastClose < average
                    ? "BELOW"
                    : "EQUAL",
              definition:
                "Integer bps truncated toward zero. First-open return covers all returned bars; close-to-close covers one fewer interval. SMA uses returned closed bars only.",
            },
            candles,
          },
          sources: [
            {
              url,
              kind: "market-data",
              publishedAt: last.closeTime,
              retrievedAt,
            },
          ],
          missing:
            candles.length < limit
              ? ["Fewer closed candles available than requested"]
              : [],
        };
      } catch {
        signal?.throwIfAborted();
        return {
          data: null,
          sources: [],
          missing: ["Binance candles unavailable, invalid or stale"],
        };
      }
    },
  };
}
