import { marketKlinesTool } from "../src/market-klines.js";
import { configureProxy } from "../src/network.js";
configureProxy();
try {
  const [symbol, interval = "1h", count = "30"] = process.argv.slice(2);
  const result = (await marketKlinesTool().run({
    symbol,
    interval,
    limit: Number(count),
  })) as { data: unknown };
  console.log(JSON.stringify(result, null, 2));
  if (!result.data) process.exitCode = 1;
} catch {
  console.error(
    "Usage: npm run market:klines -- BTCUSDT [1m|5m|15m|1h|4h|1d] [1-100]",
  );
  process.exitCode = 1;
}
