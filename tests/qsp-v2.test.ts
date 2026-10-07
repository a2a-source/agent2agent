import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResearchDecision } from "../src/qsp-v2.js";
import { portfolioSnapshot } from "../src/research-context.js";
const asset = {
  symbol: "ETH",
  address: "0x0000000000000000000000000000000000000001",
  decimals: 18,
  marketSymbol: "ETHUSDT",
};
function fixture() {
  const now = Date.now();
  const context: any = {
    at: now,
    chainId: 56,
    universe: [asset],
    portfolio: portfolioSnapshot(
      [{ ...asset, quantity: "0", priceMicros: "1000000", costMicros: null }],
      true,
    ),
    markets: [{ ...asset, asOf: now, priceMicros: "1000000", evidenceId: "m" }],
    liquidity: [{ asset: asset.address, liquidityUsd: 1e7, observedAt: now }],
    policy: {
      maxAssetBps: 3000,
      maxTotalBps: 8000,
      minLiquidityUsd: 1e6,
      maxSlippageBps: 100,
    },
    evidence: [{ id: "m" }],
  };
  const reports: any = [{ role: "market", evidenceIds: ["m"] }];
  return {
    context,
    reports,
    decision: {
      summary: "Hold cash until verified execution is available",
      decisions: [{ role: "market", decision: "ACCEPT", reason: "supported" }],
      disagreements: [],
      signals: [],
      risks: ["No execution"],
    },
  };
}
test("v2 requires coverage, real evidence, bounded weights and actual holdings for SELL", () => {
  const f = fixture();
  f.context.portfolio = portfolioSnapshot(
    [
      {
        ...asset,
        address: "0x0000000000000000000000000000000000000000",
        quantity: "1000000000000000000",
        priceMicros: "1000000",
        costMicros: null,
      },
    ],
    true,
  );
  validateResearchDecision(
    f.decision,
    f.context,
    f.reports,
    Date.now(),
    600000,
  );
  assert.throws(() =>
    validateResearchDecision(
      { ...f.decision, decisions: [] },
      f.context,
      f.reports,
      Date.now(),
      600000,
    ),
  );
  const signal = {
    chainId: 56,
    asset: asset.address,
    action: "BUY",
    targetWeightBps: 2000,
    rationale: "research",
    evidence: ["m"],
    conditions: ["fresh DEX quote"],
    invalidation: ["stale data"],
    maxSlippageBps: 100,
  };
  validateResearchDecision(
    { ...f.decision, signals: [signal] },
    f.context,
    f.reports,
    Date.now(),
    600000,
  );
  for (const change of [
    { targetWeightBps: 9000 },
    { evidence: ["fake"] },
    { chainId: 97 },
    { action: "SELL", targetWeightBps: 0 },
  ])
    assert.throws(() =>
      validateResearchDecision(
        { ...f.decision, signals: [{ ...signal, ...change }] },
        f.context,
        f.reports,
        Date.now(),
        600000,
      ),
    );
  f.context.portfolio.status = "UNKNOWN";
  assert.throws(() =>
    validateResearchDecision(
      { ...f.decision, signals: [signal] },
      f.context,
      f.reports,
      Date.now(),
      600000,
    ),
  );
});
test("zero capital cannot yield a BUY and material missing valuations cannot be traded", () => {
  const f = fixture();
  const signal = {
    chainId: 56,
    asset: asset.address,
    action: "BUY",
    targetWeightBps: 2000,
    rationale: "research",
    evidence: ["m"],
    conditions: ["fresh DEX quote"],
    invalidation: ["stale"],
    maxSlippageBps: 100,
  };
  assert.throws(
    () =>
      validateResearchDecision(
        { ...f.decision, signals: [signal] },
        f.context,
        f.reports,
        Date.now(),
        600000,
      ),
    /capital/,
  );
});
import { normalizeReport } from "../src/qsp-v2.js";
test("source URLs are derived from verified evidence references, never invented by the model", () => {
  const ctx: any = {
    evidence: [{ id: "abcdef", url: "https://example.com/proof" }],
  };
  const report = normalizeReport(
    {
      summary: "s",
      missing: [],
      evidenceIds: ["E1"],
      recommendation: "observe",
      uncertainty: "u",
    },
    ctx,
  );
  assert.deepEqual(report.sources, ["https://example.com/proof"]);
  assert.deepEqual(report.evidenceIds, ["abcdef"]);
  assert.throws(
    () =>
      normalizeReport(
        {
          summary: "s",
          missing: [],
          evidenceIds: ["E2"],
          recommendation: "observe",
          uncertainty: "u",
        },
        ctx,
      ),
    /evidence/,
  );
});
test("omitting an overweight existing holding cannot evade per-asset policy", () => {
  const f = fixture();
  const other = "0x0000000000000000000000000000000000000002";
  f.context.portfolio = portfolioSnapshot(
    [
      {
        ...asset,
        address: other,
        quantity: "1000000000000000000",
        priceMicros: "1000000",
        costMicros: null,
      },
      {
        ...asset,
        address: "0x0000000000000000000000000000000000000000",
        quantity: "1000000000000000000",
        priceMicros: "1000000",
        costMicros: null,
      },
    ],
    true,
  );
  const s = {
    chainId: 56,
    asset: asset.address,
    action: "BUY",
    targetWeightBps: 2000,
    rationale: "research",
    evidence: ["m"],
    conditions: ["fresh quote"],
    invalidation: ["stale"],
    maxSlippageBps: 100,
  };
  assert.throws(
    () =>
      validateResearchDecision(
        { ...f.decision, signals: [s] },
        f.context,
        f.reports,
        Date.now(),
        600000,
      ),
    /omitted.*policy/,
  );
});
