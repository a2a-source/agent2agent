import type { ResearchContext } from "./research-context.js";
import { hash } from "./protocol.js";
const NATIVE = "0x0000000000000000000000000000000000000000";
/** Exact comparisons use cross products; displayed bps are truncated, never the authority. */
export function researchFacts(c: ResearchContext) {
  const known = c.portfolio.status !== "UNKNOWN";
  const value =
    known && c.portfolio.valueMicros !== null
      ? BigInt(c.portfolio.valueMicros)
      : null;
  const exposure = (amount: string | null, limit: number | null) => {
    const n = known && amount !== null ? BigInt(amount) : null;
    return {
      valueMicros: n === null ? null : String(n),
      weightBps:
        n === null || value === null
          ? null
          : value === 0n
            ? 0
            : Number((n * 10000n) / value),
      limitBps: limit,
      overLimit:
        n === null || value === null || limit === null
          ? null
          : n * 10000n > value * BigInt(limit),
    };
  };
  const assets = c.universe.map((a) => {
    const p = c.portfolio.positions.find(
      (p) => p.address.toLowerCase() === a.address.toLowerCase(),
    );
    return {
      asset: a.address,
      symbol: a.symbol,
      decimals: a.decimals,
      quantity: known && p ? p.quantity : null,
      ...exposure(p?.valueMicros ?? null, c.policy.maxAssetBps),
    };
  });
  const allKnown = assets.every((a) => a.valueMicros !== null);
  const total = allKnown
    ? String(assets.reduce((n, a) => n + BigInt(a.valueMicros!), 0n))
    : null;
  const native = c.portfolio.positions.find(
    (p) => p.address.toLowerCase() === NATIVE,
  );
  return {
    valuationCurrency: "USDT_REFERENCE_NOT_REQUIRED_FUNDING",
    portfolioValueMicros: value === null ? null : String(value),
    assets,
    totalTokens: exposure(total, c.policy.maxTotalBps),
    nativeFunding: {
      quantity: known && native ? native.quantity : null,
      decimals: native?.decimals ?? 18,
      ...exposure(native?.valueMicros ?? null, null),
      scope: "SNAPSHOT_AFTER_GAS_RESERVE_NOT_EXECUTION_QUOTE",
      priceRisk: "BNB_IS_NOT_A_STABLECOIN",
    },
    scope: "CONFIGURED_TOKENS_ONLY_NATIVE_BNB_SEPARATE",
  };
}
export function researchChecks(c: ResearchContext) {
  const facts = researchFacts(c);
  return {
    profile: "c4/1" as const,
    facts,
    currentViolations: [
      ...facts.assets
        .filter((a) => a.overLimit === true)
        .map((a) => ({ code: "ASSET_LIMIT", asset: a.asset })),
      ...(facts.totalTokens.overLimit === true
        ? [{ code: "TOTAL_TOKEN_LIMIT", asset: "" }]
        : []),
    ],
    hardRules: "HARD_POLICY_OVERRIDES_TEXT_CONDITIONS" as const,
  };
}
export function verifyResearchChecks(raw: unknown, c: ResearchContext) {
  if (hash(raw) !== hash(researchChecks(c)))
    throw Error("C4 research checks mismatch");
}
/** Additional exact limits for new c4/1 outputs only; legacy signatures keep legacy rules. */
export function validateC4Targets(
  signals: { asset: string; targetWeightBps: number; action?: string }[],
  c: ResearchContext,
) {
  if (!signals.length) return;
  const value =
    c.portfolio.valueMicros === null ? null : BigInt(c.portfolio.valueMicros);
  if (value === null || c.portfolio.status === "UNKNOWN")
    throw Error("C4 policy requires known valuation");
  let total = 0n;
  for (const a of c.universe) {
    const s = signals.find(
      (s) => s.asset.toLowerCase() === a.address.toLowerCase(),
    );
    const p = c.portfolio.positions.find(
      (p) => p.address.toLowerCase() === a.address.toLowerCase(),
    );
    const unchanged = !s || s.action === "HOLD";
    if (unchanged && (!p || p.valueMicros === null))
      throw Error("C4 policy requires known position valuation");
    const numerator = unchanged
      ? BigInt(p!.valueMicros!) * 10000n
      : BigInt(s!.targetWeightBps) * value;
    if (numerator > value * BigInt(c.policy.maxAssetBps))
      throw Error("C4 policy per-asset target exceeded");
    total += numerator;
  }
  if (total > value * BigInt(c.policy.maxTotalBps))
    throw Error("C4 policy total target exceeded");
}
