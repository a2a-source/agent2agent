import { test } from "node:test";
import assert from "node:assert/strict";
import { planWallet } from "../src/wallet-planner.js";
const token = "0x0000000000000000000000000000000000000001";
const wallet = "0x0000000000000000000000000000000000000002";
function fixture(): any {
  return {
    strategy: {
      version: "allocation-preview/1",
      id: "example",
      chainId: 56,
      createdAt: 1000,
      validUntil: 2000,
      targets: [{ asset: token, weightBps: 2000 }],
    },
    policy: {
      allowedAssets: [token],
      maxAssetBps: 3000,
      maxTotalBps: 8000,
      maxTurnoverBps: 10000,
      maxSnapshotAgeMs: 500,
    },
    snapshot: {
      agent: "a",
      wallet,
      chainId: 56,
      observedAt: 1000,
      nativeBalanceWei: "10000000000000000000",
      nativePriceMicros: "100000000",
      gasReserveWei: "0",
      pendingNativeWei: "0",
      positions: [
        {
          asset: token,
          decimals: 18,
          balance: "0",
          pending: "0",
          priceMicros: "100000000",
        },
      ],
    },
  };
}
test("same target produces independent BUY and SELL previews, never orders", () => {
  const a = fixture(),
    b = fixture();
  b.snapshot.agent = "b";
  b.snapshot.wallet = "0x0000000000000000000000000000000000000003";
  b.snapshot.nativeBalanceWei = "6000000000000000000";
  b.snapshot.positions[0].balance = "4000000000000000000";
  const buy = planWallet(a, 1100),
    sell = planWallet(b, 1100);
  assert.equal(buy.items[0]?.side, "BUY");
  assert.equal(buy.items[0]?.referenceValueMicros, "200000000");
  assert.equal(sell.items[0]?.side, "SELL");
  assert.equal(sell.items[0]?.referenceQuantity, "2000000000000000000");
  assert.notEqual(buy.id, sell.id);
  assert.equal(buy.previewOnly, true);
  assert.equal(buy.executed, false);
  assert.deepEqual(planWallet(a, 1100), buy);
});
test("native reservations are removed before valuation, without modifying inputs", () => {
  const f = fixture();
  f.snapshot.gasReserveWei = "1000000000000000000";
  f.snapshot.pendingNativeWei = "2000000000000000000";
  const before = JSON.stringify(f),
    p = planWallet(f, 1100);
  assert.equal(p.portfolioValueMicros, "700000000");
  assert.equal(p.items[0]?.referenceValueMicros, "140000000");
  assert.equal(JSON.stringify(f), before);
});
test("missing/duplicate/unknown targets and positions fail closed", () => {
  for (const change of [
    (f: any) => (f.strategy.targets = []),
    (f: any) => (f.snapshot.positions = []),
    (f: any) => f.strategy.targets.push({ ...f.strategy.targets[0] }),
    (f: any) => f.snapshot.positions.push({ ...f.snapshot.positions[0] }),
    (f: any) => (f.policy.allowedAssets = []),
    (f: any) =>
      (f.snapshot.positions[0].asset =
        "0x0000000000000000000000000000000000000000"),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => planWallet(f, 1100));
  }
});
test("expired, stale, future, mismatched and unsafe inputs are rejected", () => {
  for (const change of [
    (f: any) => (f.strategy.validUntil = 1100),
    (f: any) => (f.strategy.createdAt = 1101),
    (f: any) => (f.snapshot.observedAt = 599),
    (f: any) => (f.snapshot.observedAt = 1101),
    (f: any) => (f.snapshot.chainId = 97),
    (f: any) => (f.snapshot.nativePriceMicros = "0"),
    (f: any) => (f.snapshot.positions[0].priceMicros = "-1"),
    (f: any) => (f.snapshot.positions[0].decimals = 100),
    (f: any) => (f.policy.maxAssetBps = 1999),
    (f: any) => (f.policy.maxTotalBps = 1999),
    (f: any) => (f.snapshot.gasReserveWei = "11000000000000000000"),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => planWallet(f, 1100));
  }
  assert.throws(() => planWallet(fixture(), Number.MAX_SAFE_INTEGER + 1));
});
test("reserved tokens remain exposure but cannot be sold", () => {
  const f = fixture();
  f.snapshot.nativeBalanceWei = "0";
  f.snapshot.positions[0].balance = "10000000000000000000";
  f.snapshot.positions[0].pending = "9000000000000000000";
  assert.throws(() => planWallet(f, 1100), /reserved/);
});
test("turnover is bounded and unconfirmed sales cannot finance buys", () => {
  const f = fixture();
  f.policy.maxTurnoverBps = 1999;
  assert.throws(() => planWallet(f, 1100), /turnover/);
  const g = fixture(),
    other = "0x0000000000000000000000000000000000000004";
  g.policy.allowedAssets.push(other);
  g.strategy.targets.push({ asset: other, weightBps: 0 });
  g.snapshot.nativeBalanceWei = "0";
  g.snapshot.positions.push({
    ...g.snapshot.positions[0],
    asset: other,
    balance: "10000000000000000000",
  });
  assert.throws(() => planWallet(g, 1100), /buy budget/);
});
test("rounding and huge balances use integer arithmetic, holdings at target do not trade", () => {
  const f = fixture();
  f.snapshot.nativeBalanceWei = "8000000000000000000";
  f.snapshot.positions[0].balance = "2000000000000000000";
  assert.deepEqual(planWallet(f, 1100).items, []);
  f.snapshot.nativeBalanceWei = "100000000000000000000000000000000000";
  f.snapshot.positions[0].balance = "0";
  assert.equal(
    planWallet(f, 1100).items[0]?.referenceValueMicros,
    "2000000000000000000000000",
  );
  const g = fixture();
  g.snapshot.nativeBalanceWei = "1";
  assert.equal(planWallet(g, 1100).portfolioValueMicros, "0");
  assert.deepEqual(planWallet(g, 1100).items, []);
});

test("a preview is never returned at its freshness expiry boundary", () => {
  assert.throws(() => planWallet(fixture(), 1500), /freshness/);
  assert.equal(planWallet(fixture(), 1499).validUntil, 1500);
});

test("case-variant duplicate asset identities cannot bypass coverage", () => {
  const f = fixture();
  const lower = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const upper = "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";
  f.strategy.targets = [
    { asset: lower, weightBps: 1000 },
    { asset: upper, weightBps: 1000 },
  ];
  f.snapshot.positions = [
    { ...f.snapshot.positions[0], asset: lower },
    { ...f.snapshot.positions[0], asset: upper },
  ];
  f.policy.allowedAssets = [lower, upper];
  assert.throws(() => planWallet(f, 1100), /duplicate/);
});

test("three synthetic rounds use supplied balances and price changes, never assumed fills", () => {
  const f = fixture();
  assert.equal(planWallet(f, 1100).items[0]?.side, "BUY");
  // Without an updated snapshot, the previous proposal does not alter holdings.
  assert.equal(planWallet(f, 1101).items[0]?.side, "BUY");
  // Explicit synthetic balance update representing a separately confirmed purchase.
  f.snapshot.nativeBalanceWei = "8000000000000000000";
  f.snapshot.positions[0].balance = "2000000000000000000";
  f.snapshot.observedAt = 1200;
  assert.deepEqual(planWallet(f, 1201).items, []);
  // Same holdings, changed reference mark: the original target now requires selling.
  f.snapshot.positions[0].priceMicros = "200000000";
  f.snapshot.observedAt = 1300;
  const repriced = planWallet(f, 1301);
  assert.equal(repriced.portfolioValueMicros, "1200000000");
  assert.equal(repriced.items[0]?.side, "SELL");
  assert.equal(repriced.items[0]?.referenceQuantity, "800000000000000000");
  assert.equal(repriced.items[0]?.referenceValueMicros, "160000000");
});

test("the zero address cannot identify an Agent wallet", () => {
  const f = fixture();
  f.snapshot.wallet = "0x0000000000000000000000000000000000000000";
  assert.throws(() => planWallet(f, 1100));
});
