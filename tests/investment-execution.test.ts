import test from "node:test";
import assert from "node:assert/strict";
import { compileExecutionOrders } from "../src/investment-execution.js";
const stable = "0x" + "1".repeat(40),
  btc = "0x" + "2".repeat(40);
const registry: any = {
  assets: [
    { asset: "native", bucket: "BNB", decimals: 18 },
    { asset: stable, bucket: "STABLE", decimals: 6 },
    { asset: btc, bucket: "BTC", decimals: 18 },
  ],
};
const snapshot: any = {
  holdings: [
    {
      asset: "native",
      priceMicros: "600000000",
      balance: "10000000000000000",
      reserved: "0",
      gasExcluded: "1000000000000000",
    },
    {
      asset: stable,
      priceMicros: "1000000",
      balance: "1000000000",
      reserved: "0",
      gasExcluded: "0",
    },
    {
      asset: btc,
      priceMicros: "100000000000",
      balance: "1000000000000000",
      reserved: "0",
      gasExcluded: "0",
    },
  ],
};
test("execution converts USD notional to exact input units without crediting sale proceeds", () => {
  const orders = compileExecutionOrders(
    {
      orders: [{ side: "BUY", bucket: "BTC", notionalMicros: "100000000" }],
    } as any,
    snapshot,
    registry,
  );
  assert.equal(orders[0]!.amountIn, "100000000");
  assert.equal(orders[0]!.input, stable);
  assert.equal(orders[0]!.output, btc);
  const sells = compileExecutionOrders(
    {
      orders: [{ side: "SELL", bucket: "BTC", notionalMicros: "50000000" }],
    } as any,
    snapshot,
    registry,
  );
  assert.equal(sells[0]!.amountIn, "500000000000000");
});
test("execution rejects ambiguous reserve assets and native-only sales before signing", () => {
  assert.throws(() =>
    compileExecutionOrders(
      {
        orders: [{ side: "SELL", bucket: "BNB", notionalMicros: "10000000" }],
      } as any,
      snapshot,
      registry,
    ),
  );
  assert.throws(() =>
    compileExecutionOrders(
      {
        orders: [{ side: "BUY", bucket: "BTC", notionalMicros: "10000000" }],
      } as any,
      snapshot,
      {
        assets: [
          ...registry.assets,
          { asset: "0x" + "3".repeat(40), bucket: "STABLE", decimals: 6 },
        ],
      } as any,
    ),
  );
});
