import {
  roundObservationSummarySchema,
  buildAccountingBrief,
} from "./round-observation-context.js";
import { z } from "zod";
import { researchFacts } from "./research-facts.js";
import { isAddress, formatUnits } from "ethers";
import { hash } from "./protocol.js";
import { executionFeedbackSummarySchema } from "./execution-feedback.js";
export const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(96);
const sint = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/)
  .max(96);
export const assetSchema = z
  .object({
    symbol: z.string().regex(/^[A-Z0-9]{2,12}$/),
    address: z.string().refine(isAddress),
    decimals: z.number().int().min(0).max(36),
    marketSymbol: z.string().regex(/^[A-Z0-9]{3,24}USDT$/),
  })
  .strict();
export type ResearchAsset = z.infer<typeof assetSchema>;
const REGISTRY: Record<
  string,
  { symbol: string; marketSymbol: string; decimals: number }
> = {
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": {
    symbol: "BTCB",
    marketSymbol: "BTCUSDT",
    decimals: 18,
  },
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8": {
    symbol: "ETH",
    marketSymbol: "ETHUSDT",
    decimals: 18,
  },
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": {
    symbol: "WBNB",
    marketSymbol: "BNBUSDT",
    decimals: 18,
  },
};
export const testnetProfileSchema = z
  .object({
    kind: z.literal("bsc97-test-assets/1"),
    registryHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ResearchTestnetProfile = z.infer<typeof testnetProfileSchema>;
/** A signed test profile binds the complete mapping, independent of address case/order. */
export function researchAssetRegistryHash(assets: ResearchAsset[]) {
  return hash(
    assets
      .map((a) => ({ ...a, address: a.address.toLowerCase() }))
      .sort((a, b) => a.marketSymbol.localeCompare(b.marketSymbol)),
  );
}
export function assertResearchAssets(
  chainId: number,
  assets: ResearchAsset[],
  testnetProfile?: ResearchTestnetProfile,
) {
  if (chainId === 97) {
    const profile = testnetProfileSchema.safeParse(testnetProfile);
    const parsed = z.array(assetSchema).length(3).safeParse(assets);
    if (
      !profile.success ||
      !parsed.success ||
      new Set(assets.map((a) => a.address.toLowerCase())).size !== 3 ||
      new Set(assets.map((a) => a.symbol)).size !== 3 ||
      assets
        .map((a) => a.marketSymbol)
        .sort()
        .join(",") !== "BNBUSDT,BTCUSDT,ETHUSDT" ||
      profile.data.registryHash !== researchAssetRegistryHash(assets)
    )
      throw Error(
        "research asset registry requires a complete matching BSC97 test profile",
      );
    return;
  }
  if (testnetProfile !== undefined)
    throw Error("research asset registry test profile is restricted to BSC97");
  if (chainId !== 56)
    throw Error("research asset registry supports BSC mainnet only");
  for (const a of assets) {
    const known = REGISTRY[a.address.toLowerCase()];
    if (
      !known ||
      known.symbol !== a.symbol ||
      known.marketSymbol !== a.marketSymbol ||
      known.decimals !== a.decimals
    )
      throw Error("research asset registry mapping mismatch");
  }
}
export const positionSchema = assetSchema.extend({
  quantity: uint,
  priceMicros: uint.nullable(),
  costMicros: uint.nullable(),
  valueMicros: uint.nullable(),
  unrealizedPnlMicros: sint.nullable(),
  returnBps: z.number().int().safe().nullable(),
});
export const portfolioSchema = z
  .object({
    status: z.enum(["EMPTY", "FUNDED", "UNKNOWN"]),
    quoteCurrency: z.literal("USDT"),
    valuation: z.literal("REFERENCE_MARK"),
    positions: z.array(positionSchema).max(32),
    valueMicros: uint.nullable(),
    unrealizedPnlMicros: sint.nullable(),
    returnBps: z.number().int().safe().nullable(),
    realizedPnlMicros: sint.nullable(),
    missing: z.array(z.string()).max(32),
  })
  .strict();
export const marketSchema = assetSchema.extend({
  priceMicros: uint,
  asOf: z.number().int(),
  changeBps: z.number().int().safe(),
  volatilityBps: z.number().int().nonnegative().safe(),
  smaMicros: uint,
  samples: z.number().int(),
  evidenceId: z.string(),
});
export const evidenceSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["market", "dex", "portfolio", "news", "web", "accounting"]),
    url: z.string(),
    asOf: z.number().int().nullable(),
    retrievedAt: z.number().int(),
    contentHash: z.string(),
  })
  .strict();
export const contextSchema = z
  .object({
    version: z.literal("research-context/1"),
    at: z.number().int(),
    chainId: z.number().int().positive(),
    universe: z.array(assetSchema).min(1).max(24),
    testnetProfile: testnetProfileSchema.optional(),
    executionFeedback: executionFeedbackSummarySchema.optional(),
    roundObservation: roundObservationSummarySchema.optional(),
    portfolio: portfolioSchema,
    portfolioIdentity: z.object({
      wallet: z.string(),
      scope: z.literal("CONFIGURED_ASSETS_AND_NATIVE"),
      blockNumber: z.number().int().nullable(),
      blockHash: z.string().nullable(),
      nativeBalanceWei: uint.nullable(),
      gasReserveWei: uint,
      stakeExcluded: z.literal(true),
    }),
    markets: z.array(marketSchema),
    liquidity: z.array(
      z.object({
        asset: z.string(),
        pair: z.string(),
        dex: z.string(),
        liquidityUsd: z.number().nonnegative().finite(),
        evidenceId: z.string(),
        observedAt: z.number().int(),
        sourceTimestamp: z.null(),
      }),
    ),
    news: z
      .array(
        z.object({
          title: z.string(),
          url: z.string(),
          publishedAt: z.number().nullable(),
          evidenceId: z.string(),
        }),
      )
      .max(20),
    evidence: z.array(evidenceSchema).max(128),
    missing: z.array(z.string()).max(64),
    previous: z
      .object({
        epoch: z.string(),
        hash: z.string(),
        signals: z.array(z.unknown()),
      })
      .nullable(),
    changes: z.object({
      portfolioValueDeltaMicros: sint.nullable(),
      investmentReturnBps: z.null(),
      returnMissing: z.string(),
      positions: z.array(z.object({ asset: z.string(), quantityDelta: sint })),
      prices: z.array(
        z.object({ asset: z.string(), changeBps: z.number().int().safe() }),
      ),
    }),
    policy: z.object({
      dataMaxAgeMs: z.number().int().positive().optional(),
      maxAssetBps: z.number().int().min(0).max(10000),
      maxTotalBps: z.number().int().min(0).max(10000),
      validForMs: z.number().int().positive(),
      minLiquidityUsd: z.number().nonnegative(),
      maxSlippageBps: z.number().int().min(0).max(10000),
    }),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.roundObservation && c.roundObservation.chainId !== c.chainId)
      ctx.addIssue({
        code: "custom",
        message: "round observation chain mismatch",
      });
    if (c.executionFeedback && c.executionFeedback.chainId !== c.chainId)
      ctx.addIssue({
        code: "custom",
        message: "execution feedback chain mismatch",
      });
  });
export type ResearchContext = z.infer<typeof contextSchema>;
function ratio(n: bigint, d: bigint): number | null {
  if (d <= 0n) return null;
  const v = (n * 10000n) / d;
  return v > BigInt(Number.MAX_SAFE_INTEGER) ||
    v < BigInt(Number.MIN_SAFE_INTEGER)
    ? null
    : Number(v);
}
export function portfolioSnapshot(
  rows: (ResearchAsset & {
    quantity: string;
    priceMicros: string | null;
    costMicros: string | null;
  })[],
  known: boolean,
) {
  const positions = rows.map((r) => {
    const quantity = BigInt(uint.parse(r.quantity));
    const value =
      quantity === 0n
        ? 0n
        : r.priceMicros === null
          ? null
          : (quantity * BigInt(uint.parse(r.priceMicros))) /
            10n ** BigInt(r.decimals);
    const cost =
      r.costMicros === null ? null : BigInt(uint.parse(r.costMicros));
    const pnl = value !== null && cost !== null ? value - cost : null;
    return {
      ...r,
      valueMicros: value === null ? null : String(value),
      unrealizedPnlMicros: pnl === null ? null : String(pnl),
      returnBps: pnl !== null && cost !== null ? ratio(pnl, cost) : null,
    };
  });
  const value =
    known && positions.every((p) => p.valueMicros !== null)
      ? positions.reduce((a, p) => a + BigInt(p.valueMicros!), 0n)
      : null;
  const cost =
    known && positions.every((p) => p.quantity === "0" || p.costMicros !== null)
      ? positions.reduce((a, p) => a + BigInt(p.costMicros ?? "0"), 0n)
      : null;
  const pnl = value !== null && cost !== null ? value - cost : null;
  return portfolioSchema.parse({
    status: !known
      ? "UNKNOWN"
      : positions.every((p) => p.quantity === "0")
        ? "EMPTY"
        : "FUNDED",
    quoteCurrency: "USDT",
    valuation: "REFERENCE_MARK",
    positions,
    valueMicros: value === null ? null : String(value),
    unrealizedPnlMicros: pnl === null ? null : String(pnl),
    returnBps: pnl !== null && cost !== null ? ratio(pnl, cost) : null,
    realizedPnlMicros: null,
    missing: [
      ...(!known ? ["Portfolio balances unavailable"] : []),
      ...(cost === null
        ? [
            "Cost basis unavailable; wallet balances do not establish purchase costs",
          ]
        : []),
      "Realized PnL and cashflow-adjusted returns require verified execution/accounting history",
      "CEX USDT reference marks are not executable DEX quotes or USD parity guarantees",
    ],
  });
}
export function marketMetrics(
  candles: { closeTime: number; closeMicros: string }[],
) {
  if (candles.length < 20) throw Error("market candles insufficient");
  let last = -1;
  const values = candles.map((c) => {
    if (!Number.isSafeInteger(c.closeTime) || c.closeTime <= last)
      throw Error("market candles unordered");
    last = c.closeTime;
    const v = BigInt(uint.parse(c.closeMicros));
    if (v <= 0n) throw Error("market price nonpositive");
    return v;
  });
  const returns = values
    .slice(1)
    .map((v, i) => ratio(v - values[i]!, values[i]!)!);
  if (returns.some((r) => r === null)) throw Error("market ratio overflow");
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volatilityBps = Math.round(
    Math.sqrt(
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length,
    ),
  );
  return {
    changeBps: ratio(values.at(-1)! - values[0]!, values[0]!)!,
    volatilityBps,
    smaMicros: String(
      values.reduce((a, b) => a + b, 0n) / BigInt(values.length),
    ),
    samples: values.length,
  };
}
export function compareContext(previous: any, current: any) {
  const identity = (x: any) =>
    x
      ? {
          chainId: x.chainId ?? null,
          wallet: x.portfolioIdentity?.wallet?.toLowerCase() ?? null,
          scope: x.portfolioIdentity?.scope ?? null,
          universe: x.universe ?? null,
          testnetProfile: x.testnetProfile ?? null,
        }
      : null;
  const comparable =
    !!previous && hash(identity(previous)) === hash(identity(current));
  if (!comparable)
    return {
      portfolioValueDeltaMicros: null,
      investmentReturnBps: null,
      returnMissing:
        "Comparison baseline unavailable or different wallet, chain, scope or asset universe; cashflow-adjusted return unknown",
      positions: [],
      prices: [],
    };
  const a = previous?.portfolio?.valueMicros,
    b = current.portfolio.valueMicros;
  return {
    portfolioValueDeltaMicros:
      a != null && b != null ? String(BigInt(b) - BigInt(a)) : null,
    investmentReturnBps: null,
    returnMissing:
      "Raw cross-round value change alone is not investment return without cashflow proof; consult accountingBrief for independent verified accounting windows",
    positions: current.portfolio.positions.flatMap((p: any) => {
      const old = previous?.portfolio?.positions.find(
        (x: any) => x.address.toLowerCase() === p.address.toLowerCase(),
      );
      return old
        ? [
            {
              asset: p.address,
              quantityDelta: String(BigInt(p.quantity) - BigInt(old.quantity)),
            },
          ]
        : [];
    }),
    prices: current.markets.flatMap((m: any) => {
      const old = previous?.markets?.find(
        (x: any) => x.address.toLowerCase() === m.address.toLowerCase(),
      );
      return old
        ? [
            {
              asset: m.address,
              changeBps: ratio(
                BigInt(m.priceMicros) - BigInt(old.priceMicros),
                BigInt(old.priceMicros),
              )!,
            },
          ]
        : [];
    }),
  };
}
/** Preserve external decimal numbers as decimal strings in auditable JSON; protocol numbers stay integers. */
export function normalizeEvidence(data: unknown): unknown {
  return JSON.parse(
    JSON.stringify(data, (_key, value) =>
      typeof value === "number" && !Number.isSafeInteger(value)
        ? String(value)
        : value,
    ),
  );
}
export function evidence(
  kind: z.infer<typeof evidenceSchema>["kind"],
  url: string,
  asOf: number | null,
  data: unknown,
  retrievedAt = Date.now(),
) {
  const value = {
    kind,
    url,
    asOf,
    retrievedAt,
    contentHash: hash(normalizeEvidence(data)),
  };
  return { id: hash(value), ...value };
}

/** Models consume human-readable values; the signed context retains exact base-unit integers. */
export function promptSnapshot(c: ResearchContext, role?: string) {
  const money = (v: string | null) => (v === null ? null : formatUnits(v, 6));
  const ref = (id: string) => {
    const i = c.evidence.findIndex((e) => e.id === id);
    return i < 0 ? id : `E${i + 1}`;
  };
  const facts = researchFacts(c);
  const readable = (x: any) => ({
    ...x,
    weightPercent: x.weightBps === null ? null : formatUnits(x.weightBps, 2),
    limitPercent: x.limitBps === null ? null : formatUnits(x.limitBps, 2),
  });
  return {
    facts: {
      ...facts,
      assets: facts.assets.map(readable),
      totalTokens: readable(facts.totalTokens),
      nativeFunding: readable(facts.nativeFunding),
    },
    at: c.at,
    atISO: new Date(c.at).toISOString(),
    chainId: c.chainId,
    ...(c.testnetProfile ? { testnetProfile: c.testnetProfile } : {}),
    units:
      "Portfolio and market price/value/cost/PnL fields are USDT reference marks. executionFeedback and roundObservation retain exact micro-USD integers and is independent of those reference marks; NAV delta is not profit and UNKNOWN is not zero. Percent fields are percentages, not basis points. DEX liquidity is whole USD.",
    ...(c.executionFeedback ? { executionFeedback: c.executionFeedback } : {}),
    ...(c.roundObservation ? { roundObservation: c.roundObservation } : {}),
    accountingBrief: buildAccountingBrief(c),
    portfolio: {
      status: c.portfolio.status,
      quoteCurrency: c.portfolio.quoteCurrency,
      valueUSDT: money(c.portfolio.valueMicros),
      unrealizedPnlUSDT: money(c.portfolio.unrealizedPnlMicros),
      realizedPnlUSDT: money(c.portfolio.realizedPnlMicros),
      returnPercent:
        c.portfolio.returnBps === null
          ? null
          : formatUnits(c.portfolio.returnBps, 2),
      positions: c.portfolio.positions.map((p) => ({
        symbol: p.symbol,
        asset: p.address,
        quantity: formatUnits(p.quantity, p.decimals),
        valueUSDT: money(p.valueMicros),
        costUSDT: money(p.costMicros),
        unrealizedPnlUSDT: money(p.unrealizedPnlMicros),
        returnPercent:
          p.returnBps === null ? null : formatUnits(p.returnBps, 2),
      })),
      missing: c.portfolio.missing,
    },
    markets: c.markets.map((m) => ({
      symbol: m.symbol,
      asset: m.address,
      priceUSDT: money(m.priceMicros),
      smaUSDT: money(m.smaMicros),
      priceVsSma:
        BigInt(m.priceMicros) > BigInt(m.smaMicros)
          ? "ABOVE"
          : BigInt(m.priceMicros) < BigInt(m.smaMicros)
            ? "BELOW"
            : "EQUAL",
      smaDeviationPercent:
        BigInt(m.smaMicros) > 0n
          ? formatUnits(
              ((BigInt(m.priceMicros) - BigInt(m.smaMicros)) * 10000n) /
                BigInt(m.smaMicros),
              2,
            )
          : null,
      changePercent: formatUnits(m.changeBps, 2),
      volatilityPercent: formatUnits(m.volatilityBps, 2),
      samples: m.samples,
      changeWindowMinutes: m.samples - 1,
      volatilityDefinition:
        "Population standard deviation of 1-minute returns; not annualized",
      interval: "1 minute",
      asOf: m.asOf,
      evidence: ref(m.evidenceId),
    })),
    liquidity: c.liquidity.map((l) => ({
      ...l,
      evidenceId: ref(l.evidenceId),
    })),
    news: (role === "onchain" ? [] : c.news).map((n) => ({
      verification: "HEADLINE_ONLY",
      title: n.title,
      url: n.url,
      publishedAt: n.publishedAt,
      publishedAtISO:
        n.publishedAt !== null &&
        Number.isFinite(new Date(n.publishedAt).getTime())
          ? new Date(n.publishedAt).toISOString()
          : null,
      evidence: ref(n.evidenceId),
    })),
    evidence: c.evidence.map((e, i) => ({
      id: e.id,
      ref: `E${i + 1}`,
      kind: e.kind,
      asOf: e.asOf,
    })),
    changes: c.changes,
    previous: c.previous,
    policy: c.policy,
    missing: c.missing,
    portfolioIdentity: c.portfolioIdentity,
  };
}
