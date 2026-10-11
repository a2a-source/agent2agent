import { test } from "node:test";
import assert from "node:assert/strict";
import {
  researchFacts,
  researchChecks,
  verifyResearchChecks,
} from "../src/research-facts.js";
import { portfolioSnapshot } from "../src/research-context.js";
const asset = {
  symbol: "ETH",
  address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  decimals: 0,
  marketSymbol: "ETHUSDT",
};
function context(eth = "70", bnb = "30", known = true): any {
  return {
    universe: [asset],
    portfolio: portfolioSnapshot(
      [
        { ...asset, quantity: eth, priceMicros: "1000000", costMicros: null },
        {
          ...asset,
          symbol: "BNB",
          address: "0x0000000000000000000000000000000000000000",
          quantity: bnb,
          priceMicros: "1000000",
          costMicros: null,
        },
      ],
      known,
    ),
    portfolioIdentity: { gasReserveWei: "1", nativeBalanceWei: "31" },
    policy: { maxAssetBps: 3000, maxTotalBps: 8000 },
  };
}
test("facts distinguish configured exposure, native funding, and exact thresholds", () => {
  const c = context(),
    f = researchFacts(c);
  assert.equal(f.assets[0]!.weightBps, 7000);
  assert.equal(f.assets[0]!.overLimit, true);
  assert.equal(f.totalTokens.weightBps, 7000);
  assert.equal(f.totalTokens.overLimit, false);
  assert.equal(f.nativeFunding.quantity, "30");
  assert.equal(f.nativeFunding.weightBps, 3000);
  const allNative = researchFacts(context("0", "10"));
  assert.equal(allNative.nativeFunding.quantity, "10");
  assert.equal(allNative.totalTokens.weightBps, 0);
  const fractional = researchFacts(context("30001", "69999"));
  assert.equal(fractional.assets[0]!.weightBps, 3000);
  assert.equal(fractional.assets[0]!.overLimit, true);
});
test("unknown values stay unknown and frozen checks reject tampering", () => {
  const c = context("0", "0", false),
    f = researchFacts(c);
  assert.equal(f.nativeFunding.quantity, null);
  assert.equal(f.totalTokens.weightBps, null);
  assert.equal(f.totalTokens.overLimit, null);
  const funded = context(),
    checks = researchChecks(funded);
  verifyResearchChecks(checks, funded);
  assert.equal(checks.currentViolations.length, 1);
  assert.throws(() =>
    verifyResearchChecks({ ...checks, currentViolations: [] }, funded),
  );
});
import { validateC4Targets } from "../src/research-facts.js";
test("new profile rejects fractional omitted overweight but preserves no-action risk records", () => {
  const c = context("30001", "69999");
  assert.throws(
    () => validateC4Targets([{ asset: "other", targetWeightBps: 1 }], c),
    /policy/,
  );
  validateC4Targets([], c);
  assert.equal(researchChecks(c).currentViolations.length, 1);
  validateC4Targets([{ asset: asset.address, targetWeightBps: 3000 }], c);
});
test("HOLD preserves actual fractional exposure instead of rounding it down to target", () => {
  const c = context("30001", "69999");
  assert.throws(
    () =>
      validateC4Targets(
        [{ asset: asset.address, action: "HOLD", targetWeightBps: 3000 }],
        c,
      ),
    /policy/,
  );
});
test("aggregate HOLD exposure keeps sub-basis-point fractions", () => {
  const c = context("40001", "19998");
  const second = {
    ...asset,
    symbol: "WBNB",
    address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    quantity: "40001",
    priceMicros: "1000000",
    costMicros: null,
  };
  c.universe.push(second);
  c.portfolio = portfolioSnapshot(
    [...c.portfolio.positions.map((p: any) => ({ ...p })), second],
    true,
  );
  c.policy.maxAssetBps = 5000;
  assert.equal(researchFacts(c).totalTokens.weightBps, 8000);
  assert.equal(researchFacts(c).totalTokens.overLimit, true);
  assert.throws(
    () =>
      validateC4Targets(
        c.universe.map((a: any) => ({
          asset: a.address,
          action: "HOLD",
          targetWeightBps: 4000,
        })),
        c,
      ),
    /total target/,
  );
});
