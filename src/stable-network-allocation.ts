import { z } from "zod";
import {
  networkAllocationSchema,
  validateNetworkAllocation,
} from "./network-allocation.js";
import {
  assertResearchAssets,
  type ResearchContext,
} from "./research-context.js";
export const stableNetworkAllocationSchema = networkAllocationSchema
  .extend({
    version: z.literal("stable-network-allocation/1"),
    reserve: z.literal("ALLOWLISTED_STABLECOINS"),
    nativeBnb: z.literal("INCLUDED_IN_BNB_TARGET"),
  })
  .strict();
export function validateStableNetworkAllocation(
  raw: unknown,
  context: ResearchContext,
  reports: { evidenceIds: string[] }[],
  now: number,
  maxAgeMs: number,
) {
  const a = stableNetworkAllocationSchema.parse(raw);
  assertResearchAssets(
    context.chainId,
    context.universe,
    context.testnetProfile,
  );
  if (
    context.universe.length !== 3 ||
    new Set(context.universe.map((x) => x.marketSymbol)).size !== 3
  )
    throw Error("stable allocation requires BTC ETH BNB universe");
  const checked = validateNetworkAllocation(
    {
      version: "network-allocation/1",
      scope: a.scope,
      targets: a.targets,
      limitations: a.limitations,
    },
    {
      ...context,
      policy: {
        ...context.policy,
        maxAssetBps: Math.min(2000, context.policy.maxAssetBps),
        maxTotalBps: Math.min(6000, context.policy.maxTotalBps),
      },
    },
    reports,
    now,
    maxAgeMs,
  );
  const targets = { BTC: 0, ETH: 0, BNB: 0 };
  for (const t of a.targets) {
    const asset = context.universe.find(
      (x) => x.address.toLowerCase() === t.asset.toLowerCase(),
    )!;
    const bucket =
      asset.marketSymbol === "BTCUSDT"
        ? "BTC"
        : asset.marketSymbol === "ETHUSDT"
          ? "ETH"
          : "BNB";
    targets[bucket] = t.targetWeightBps;
  }
  return { allocation: a, targets, validUntil: checked.validUntil };
}
