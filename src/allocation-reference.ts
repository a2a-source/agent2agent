import type { ResearchContext } from "./research-context.js";

const NATIVE = "0x0000000000000000000000000000000000000000";
/** Descriptive prompt data only. Never feeds target validation or signed research checks. */
export function allocationReferenceBrief(c: ResearchContext) {
  const portfolioKnown = c.portfolio.status !== "UNKNOWN";
  const denominator =
    portfolioKnown && c.portfolio.valueMicros !== null
      ? BigInt(c.portfolio.valueMicros)
      : null;
  const configured = c.universe.filter((a) => a.marketSymbol === "BNBUSDT");
  const tokenAddress =
    configured.length === 1 ? configured[0]!.address.toLowerCase() : null;
  const uniqueToken =
    tokenAddress !== null &&
    tokenAddress !== NATIVE &&
    c.universe.filter((a) => a.address.toLowerCase() === tokenAddress)
      .length === 1;
  const exposure = (asset: string | null, identityKnown: boolean) => {
    const matches = identityKnown
      ? c.portfolio.positions.filter((p) => p.address.toLowerCase() === asset)
      : [];
    const value =
      portfolioKnown && matches.length === 1 ? matches[0]!.valueMicros : null;
    const bps =
      value !== null && denominator !== null && denominator > 0n
        ? (BigInt(value) * 10000n) / denominator
        : null;
    const weightBps =
      bps !== null && bps <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(bps)
        : null;
    return {
      asset: identityKnown ? asset : null,
      status: weightBps === null ? ("UNKNOWN" as const) : ("KNOWN" as const),
      valueMicros: value,
      weightBps,
    };
  };
  const configuredBnbToken = exposure(tokenAddress, uniqueToken);
  const nativeBnb = exposure(NATIVE, true);
  const combined =
    configuredBnbToken.status === "KNOWN" && nativeBnb.status === "KNOWN"
      ? BigInt(configuredBnbToken.valueMicros!) + BigInt(nativeBnb.valueMicros!)
      : null;
  const combinedBps =
    combined !== null ? (combined * 10000n) / denominator! : null;
  const combinedKnown =
    combinedBps !== null && combinedBps <= BigInt(Number.MAX_SAFE_INTEGER);
  return {
    version: "allocation-reference-brief/1" as const,
    currency: "micro-USDT" as const,
    valuation: "REFERENCE_MARK" as const,
    scope: "REPRESENTATIVE_WALLET_GAS_RESERVE_EXCLUDED" as const,
    portfolioValueMicros: denominator?.toString() ?? null,
    configuredBnbToken,
    nativeBnb,
    combinedBnb: {
      status: combinedKnown ? ("KNOWN" as const) : ("UNKNOWN" as const),
      valueMicros: combinedKnown ? combined!.toString() : null,
      weightBps: combinedKnown ? Number(combinedBps) : null,
    },
    targetScopes: {
      legacyConfiguredToken: "CONFIGURED_BNBUSDT_TOKEN_ONLY_NATIVE_SEPARATE",
      stableReserveBnb: "NATIVE_PLUS_CONFIGURED_BNBUSDT_TOKEN",
    },
    stableCommonModelCeilingsBps: {
      perAsset: Math.min(2000, c.policy.maxAssetBps),
      total: Math.min(6000, c.policy.maxTotalBps),
    },
    guidance:
      "Observed wallet weights, not recommended targets or execution authority. Combined BNB is rounded once from raw values. Common targets require independent market evidence; conservative null is allowed. Explain null as no recommendation and zero as an explicit zero target in the chosen allocation field.",
  };
}
