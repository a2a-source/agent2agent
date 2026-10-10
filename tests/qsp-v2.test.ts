import { test } from "node:test";
import assert from "node:assert/strict";
import { validateResearchDecision } from "../src/qsp-v2.js";
import { portfolioSnapshot } from "../src/research-context.js";
import { contextSchema, evidence } from "../src/research-context.js";
import { qspV2Schema } from "../src/qsp-v2.js";
import { loadConfig } from "../src/config.js";
import { hash } from "../src/protocol.js";
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
test("an overweight SELL receives deterministic policy conditions that market indicators cannot invalidate", () => {
  const f = fixture();
  f.context.portfolio = portfolioSnapshot(
    [
      {
        ...asset,
        quantity: "70000000000000000000",
        priceMicros: "1000000",
        costMicros: null,
      },
      {
        ...asset,
        symbol: "BNB",
        address: "0x0000000000000000000000000000000000000000",
        quantity: "30000000000000000000",
        priceMicros: "1000000",
        costMicros: null,
      },
    ],
    true,
  );
  const signal = {
    chainId: 56,
    asset: asset.address,
    action: "SELL",
    targetWeightBps: 3000,
    rationale: "Portfolio concentration exceeds policy; trend is negative.",
    evidence: ["m"],
    conditions: ["Wait until price rises above its SMA"],
    invalidation: ["Cancel sell if momentum turns positive"],
    maxSlippageBps: 100,
  };
  const validated = validateResearchDecision(
    { ...f.decision, signals: [signal] },
    f.context,
    f.reports,
    Date.now(),
    600000,
  );
  assert.match(
    validated.signals[0]!.conditions[0]!,
    /mandatory risk correction/i,
  );
  assert.match(
    validated.signals[0]!.invalidation[0]!,
    /only after a fresh portfolio snapshot/i,
  );
  assert.doesNotMatch(
    validated.signals[0]!.conditions.join(" "),
    /SMA|price rises/i,
  );
});
test("marked packages reject altered risk text while legacy bytes and total-only corrections remain supported", () => {
  const now = Date.now(),
    eth = loadConfig().research.assets.find((a) => a.symbol === "ETH")!;
  const proof = evidence(
    "market",
    "https://example.com/eth",
    now,
    { price: "1000000" },
    now,
  );
  const context = contextSchema.parse({
    version: "research-context/1",
    at: now,
    chainId: 56,
    universe: [eth],
    portfolio: portfolioSnapshot(
      [
        {
          ...eth,
          quantity: "70000000000000000000",
          priceMicros: "1000000",
          costMicros: null,
        },
        {
          ...eth,
          symbol: "BNB",
          address: "0x0000000000000000000000000000000000000000",
          quantity: "30000000000000000000",
          priceMicros: "1000000",
          costMicros: null,
        },
      ],
      true,
    ),
    portfolioIdentity: {
      wallet: "fixture",
      scope: "CONFIGURED_ASSETS_AND_NATIVE",
      blockNumber: null,
      blockHash: null,
      nativeBalanceWei: "30000000000000000000",
      gasReserveWei: "0",
      stakeExcluded: true,
    },
    markets: [
      {
        ...eth,
        priceMicros: "1000000",
        asOf: now,
        changeBps: 0,
        volatilityBps: 0,
        smaMicros: "1000000",
        samples: 60,
        evidenceId: proof.id,
      },
    ],
    liquidity: [],
    news: [],
    evidence: [proof],
    missing: [],
    previous: null,
    changes: {
      portfolioValueDeltaMicros: null,
      investmentReturnBps: null,
      returnMissing: "No prior snapshot",
      positions: [],
      prices: [],
    },
    policy: {
      maxAssetBps: 8000,
      maxTotalBps: 6000,
      validForMs: 300000,
      minLiquidityUsd: 0,
      maxSlippageBps: 100,
    },
  });
  const contextHash = hash(context);
  const reports = [
    {
      role: "market",
      agent: "worker",
      contextHash,
      summary: "fixture",
      recommendation: "reduce exposure",
      uncertainty: "fixture",
      missing: [],
      sources: [proof.url],
      evidenceIds: [proof.id],
      additionalEvidence: [],
    },
  ];
  const raw = {
    ...fixture().decision,
    signals: [
      {
        chainId: 56,
        asset: eth.address,
        action: "SELL",
        targetWeightBps: 6000,
        rationale: "Reduce aggregate exposure",
        evidence: [proof.id],
        conditions: ["Wait for SMA"],
        invalidation: ["Cancel when trend improves"],
        maxSlippageBps: 100,
      },
    ],
  };
  const decision = validateResearchDecision(raw, context, reports, now, 600000);
  assert.match(
    decision.signals[0]!.conditions.join(" "),
    /configured-token exposure/,
  );
  const { signals, risks, ...masterSummary } = decision;
  const q = {
    version: "a2a-qsp/2",
    epoch: "fixture",
    view: 0,
    master: "master",
    committeeHash: "committee",
    configHash: "config",
    dataAt: now,
    createdAt: now,
    validUntil: now + 300000,
    contextHash,
    context,
    reports,
    masterSummary,
    signals,
    risks,
    policyTextVersion: "c4-hard-risk-conditions/1",
    executed: false,
  };
  assert(qspV2Schema.safeParse(q).success);
  for (const field of ["conditions", "invalidation"] as const) {
    const tampered = structuredClone(q);
    tampered.signals[0]![field] = ["Cancel when SMA improves"];
    assert(!qspV2Schema.safeParse(tampered).success);
  }
  const { policyTextVersion, ...legacy } = { ...q, signals: raw.signals };
  assert.deepEqual(qspV2Schema.parse(legacy).signals, raw.signals);
  assert.equal(hash(qspV2Schema.parse(legacy)), hash(legacy));
});
