import { z } from "zod";
import { isAddress } from "ethers";
import type { ResearchContext } from "./research-context.js";
export const networkAllocationSchema = z
  .object({
    version: z.literal("network-allocation/1"),
    scope: z.literal("NETWORK_MODEL_PORTFOLIO"),
    targets: z
      .array(
        z
          .object({
            asset: z.string().refine(isAddress),
            targetWeightBps: z.number().int().min(0).max(10000),
            evidence: z.array(z.string().min(1)).min(1).max(24),
            rationale: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(24),
    limitations: z.array(z.string().min(1).max(2000)).min(1).max(24),
  })
  .strict();
export function validateNetworkAllocation(
  raw: unknown,
  context: ResearchContext,
  reports: { evidenceIds: string[] }[],
  now: number,
  maxAgeMs: number,
) {
  const a = networkAllocationSchema.parse(raw),
    seen = new Set<string>();
  let total = 0,
    validUntil = context.at + maxAgeMs;
  if (a.targets.length !== context.universe.length)
    throw Error("network targets must cover full universe");
  for (const t of a.targets) {
    const key = t.asset.toLowerCase();
    if (
      seen.has(key) ||
      !context.universe.some((x) => x.address.toLowerCase() === key)
    )
      throw Error("network target outside universe or duplicate");
    seen.add(key);
    total += t.targetWeightBps;
    if (t.targetWeightBps > context.policy.maxAssetBps)
      throw Error("network target exceeds asset cap");
    const market = context.markets.find((m) => m.address.toLowerCase() === key);
    if (!market || market.asOf > now || now - market.asOf >= maxAgeMs)
      throw Error("network market evidence expired");
    validUntil = Math.min(validUntil, market.asOf + maxAgeMs);
    if (
      !t.evidence.includes(market.evidenceId) ||
      t.evidence.some((id) => {
        const e = context.evidence.find((e) => e.id === id);
        return (
          !e ||
          !["market", "news", "dex", "web"].includes(e.kind) ||
          !reports.some((r) => r.evidenceIds.includes(id))
        );
      }) ||
      !context.evidence.some(
        (e) => e.id === market.evidenceId && e.kind === "market",
      )
    )
      throw Error("network target lacks verified market evidence");
    if (t.targetWeightBps > 0) {
      const supportingPools = context.liquidity.filter(
        (l) =>
          l.asset.toLowerCase() === key &&
          l.liquidityUsd >= context.policy.minLiquidityUsd &&
          t.evidence.includes(l.evidenceId) &&
          context.evidence.some(
            (e) => e.id === l.evidenceId && e.kind === "dex",
          ) &&
          l.observedAt <= now &&
          now - l.observedAt < maxAgeMs,
      );
      if (!supportingPools.length)
        throw Error("positive network target requires observed liquidity");
      validUntil = Math.min(
        validUntil,
        Math.max(...supportingPools.map((l) => l.observedAt + maxAgeMs)),
      );
    }
  }
  if (total > context.policy.maxTotalBps)
    throw Error("network targets exceed total cap");
  return { allocation: a, validUntil };
}
