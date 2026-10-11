import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResearchDecision } from "../src/qsp-v2.js";
const asset = "0x2170Ed0880ac9A755fd29B2688956BD959F933F8";
function fixture(): any {
  return {
    context: {
      at: 1000,
      chainId: 56,
      universe: [{ address: asset }],
      portfolio: { status: "UNKNOWN", valueMicros: null, positions: [] },
      markets: [{ address: asset, asOf: 1000, evidenceId: "market" }],
      liquidity: [
        { asset, liquidityUsd: 1000000, observedAt: 1000, evidenceId: "pool" },
      ],
      evidence: [
        { id: "market", kind: "market" },
        { id: "pool", kind: "dex" },
      ],
      policy: {
        maxAssetBps: 3000,
        maxTotalBps: 8000,
        maxSlippageBps: 100,
        minLiquidityUsd: 1000000,
      },
    },
    reports: [{ role: "market", evidenceIds: ["market", "pool"] }],
    decision: {
      summary: "shared market view",
      decisions: [{ role: "market", decision: "ACCEPT", reason: "evidence" }],
      disagreements: [],
      signals: [],
      risks: ["not an order"],
      networkAllocation: {
        version: "network-allocation/1",
        scope: "NETWORK_MODEL_PORTFOLIO",
        targets: [
          {
            asset,
            targetWeightBps: 2000,
            evidence: ["market", "pool"],
            rationale: "market research, not wallet weight",
          },
        ],
        limitations: ["reference model; no executable quote"],
      },
    },
  };
}
test("network target does not depend on the example portfolio, legacy decisions stay unchanged", () => {
  const f = fixture();
  assert.equal(
    validateResearchDecision(f.decision, f.context, f.reports, 1100, 500)
      .networkAllocation?.targets[0]?.targetWeightBps,
    2000,
  );
  delete f.decision.networkAllocation;
  assert.deepEqual(
    validateResearchDecision(f.decision, f.context, f.reports, 1100, 500),
    f.decision,
  );
});
test("network allocation rejects incomplete targets, excess caps and weak/stale evidence", () => {
  for (const mutate of [
    (f: any) => (f.decision.networkAllocation.targets = []),
    (f: any) =>
      f.decision.networkAllocation.targets.push({
        ...f.decision.networkAllocation.targets[0],
      }),
    (f: any) =>
      (f.decision.networkAllocation.targets[0].targetWeightBps = 3001),
    (f: any) => (f.context.policy.maxTotalBps = 1999),
    (f: any) =>
      (f.decision.networkAllocation.targets[0].evidence = ["made-up"]),
    (f: any) => (f.reports[0].evidenceIds = []),
    (f: any) => (f.context.markets[0].asOf = 600),
    (f: any) => (f.context.markets[0].asOf = 1101),
    (f: any) => (f.context.liquidity = []),
    (f: any) => (f.context.liquidity[0].observedAt = 1101),
    (f: any) => (f.context.evidence[0].kind = "portfolio"),
    (f: any) => (f.decision.networkAllocation.targets[0].evidence = ["market"]),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() =>
      validateResearchDecision(f.decision, f.context, f.reports, 1100, 500),
    );
  }
});
test("explicit null allocation remains null, zero targets require market evidence but no buy liquidity", () => {
  const f = fixture();
  f.decision.networkAllocation = null;
  assert.equal(
    validateResearchDecision(f.decision, f.context, f.reports, 1100, 500)
      .networkAllocation,
    null,
  );
  const g = fixture();
  g.decision.networkAllocation.targets[0].targetWeightBps = 0;
  g.context.liquidity = [];
  assert.equal(
    validateResearchDecision(g.decision, g.context, g.reports, 1100, 500)
      .networkAllocation?.targets[0]?.targetWeightBps,
    0,
  );
});
