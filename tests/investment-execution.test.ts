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

const wbnb = "0x" + "4".repeat(40);
const nativeRegistry: any = {
  assets: [...registry.assets, { asset: wbnb, bucket: "BNB", decimals: 18 }],
};
const nativeSnapshot: any = {
  holdings: [
    ...snapshot.holdings,
    {
      asset: wbnb,
      priceMicros: "600000000",
      balance: "2000000000000000",
      reserved: "0",
      gasExcluded: "0",
    },
  ],
};
const nativeOptions = {
  wrappedNative: wbnb,
  maxTransactionFeeWei: "100000000000000",
  minTradeMicros: "1",
  maxGasBps: 10000,
};
test("native compiler splits registered WBNB first and bounds total by immutable source", () => {
  const plan: any = {
    orders: [{ side: "SELL", bucket: "BNB", notionalMicros: "6000000" }],
  };
  const before = JSON.stringify(plan);
  const orders = (compileExecutionOrders as any)(
    plan,
    nativeSnapshot,
    nativeRegistry,
    nativeOptions,
  );
  assert.equal(orders.length, 2);
  assert.equal(orders[0].input, wbnb);
  assert.equal(orders[1].input, "native");
  assert.equal(orders[1].inputKind, "NATIVE");
  assert.equal(orders[1].approvalId, undefined);
  assert.equal(orders[1].version, "investment-execution-order/2");
  assert.equal(orders[1].amountIn, "8000000000000000");
  assert.ok(
    orders.reduce((s: bigint, o: any) => s + BigInt(o.notionalMicros), 0n) <=
      6000000n,
  );
  assert.equal(JSON.stringify(plan), before);
  assert.deepEqual(
    (compileExecutionOrders as any)(
      plan,
      nativeSnapshot,
      nativeRegistry,
      nativeOptions,
    ),
    orders,
  );
});
test("native zero-target allocation leaves protected reserve plus conservative whole-job fees", () => {
  const s: any = {
    holdings: nativeSnapshot.holdings.map((h: any) =>
      h.asset === wbnb ? { ...h, balance: "0" } : h,
    ),
  };
  const orders = (compileExecutionOrders as any)(
    { orders: [{ side: "SELL", bucket: "BNB", notionalMicros: "5400000" }] },
    s,
    nativeRegistry,
    nativeOptions,
  );
  assert.equal(orders.length, 1);
  assert.equal(orders[0].input, "native");
  assert.equal(orders[0].amountIn, "8700000000000000");
  assert.equal(orders[0].residualMicros, "180000");
  assert.equal(orders[0].sourceOrderIndex, 0);
  assert.equal(orders[0].intendedNotionalMicros, "5400000");
});
test("native compiler rejects insufficient combined holdings and drops uneconomic dust", () => {
  assert.throws(
    () =>
      (compileExecutionOrders as any)(
        {
          orders: [
            { side: "SELL", bucket: "BNB", notionalMicros: "999000000" },
          ],
        },
        nativeSnapshot,
        nativeRegistry,
        nativeOptions,
      ),
    /insufficient/,
  );
  assert.throws(
    () =>
      (compileExecutionOrders as any)(
        { orders: [{ side: "SELL", bucket: "BNB", notionalMicros: "1" }] },
        nativeSnapshot,
        nativeRegistry,
        { ...nativeOptions, minTradeMicros: "10000000" },
      ),
    /dust|economic/,
  );
});

test("native operating headroom is additional to current job fees and cannot enlarge a signed sale", () => {
  const s: any = {
    holdings: nativeSnapshot.holdings.map((h: any) =>
      h.asset === wbnb ? { ...h, balance: "0" } : h,
    ),
  };
  const options = { ...nativeOptions, operatingFeeWei: "600000000000000" };
  const orders = compileExecutionOrders(
    { orders: [{ side: "SELL", bucket: "BNB", notionalMicros: "5400000" }] },
    s,
    nativeRegistry,
    options,
  );
  assert.equal(orders[0]!.amountIn, "8100000000000000");
  assert.equal(orders[0]!.residualMicros, "540000");
  assert.equal(
    BigInt(orders[0]!.amountIn) + 300000000000000n + 600000000000000n,
    9000000000000000n,
  );
});
