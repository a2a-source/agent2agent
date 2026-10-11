import { z } from "zod";
import { isAddress, ZeroAddress } from "ethers";
import { hash } from "./protocol.js";
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(96);
const positive = uint.refine((v) => BigInt(v) > 0n);
const integer = z.number().int().safe().nonnegative();
const bps = integer.max(10000);
const asset = z
  .string()
  .refine(isAddress)
  .transform((v) => v.toLowerCase())
  .refine((v) => v !== ZeroAddress);
const address = z
  .string()
  .refine(isAddress)
  .transform((v) => v.toLowerCase())
  .refine((v) => v !== ZeroAddress);
export const walletPreviewInputSchema = z
  .object({
    strategy: z
      .object({
        version: z.literal("allocation-preview/1"),
        id: z.string().min(1).max(128),
        chainId: integer.positive(),
        createdAt: integer,
        validUntil: integer,
        targets: z
          .array(z.object({ asset, weightBps: bps }).strict())
          .min(1)
          .max(24),
      })
      .strict(),
    policy: z
      .object({
        allowedAssets: z.array(asset).min(1).max(24),
        maxAssetBps: bps,
        maxTotalBps: bps,
        maxTurnoverBps: bps,
        maxSnapshotAgeMs: integer.positive(),
      })
      .strict(),
    snapshot: z
      .object({
        agent: z.string().min(1).max(128),
        wallet: address,
        chainId: integer.positive(),
        observedAt: integer,
        nativeBalanceWei: uint,
        nativePriceMicros: positive,
        gasReserveWei: uint,
        pendingNativeWei: uint,
        positions: z
          .array(
            z
              .object({
                asset,
                decimals: integer.max(36),
                balance: uint,
                pending: uint,
                priceMicros: positive,
              })
              .strict(),
          )
          .min(1)
          .max(24),
      })
      .strict(),
  })
  .strict();
export interface PreviewItem {
  asset: string;
  side: "BUY" | "SELL";
  targetWeightBps: number;
  referenceQuantity: string;
  referenceValueMicros: string;
}
/** A reference-price calculator. Inputs confer no signature, wallet authority or trading eligibility. */
export function planWallet(input: unknown, now: number) {
  integer.parse(now);
  const { strategy, policy, snapshot } = walletPreviewInputSchema.parse(input);
  if (strategy.chainId !== snapshot.chainId) throw Error("chain mismatch");
  if (
    strategy.createdAt > now ||
    strategy.validUntil <= now ||
    strategy.createdAt >= strategy.validUntil
  )
    throw Error("strategy outside validity window");
  if (
    snapshot.observedAt > now ||
    now - snapshot.observedAt >= policy.maxSnapshotAgeMs
  )
    throw Error("snapshot outside freshness window");
  for (const values of [
    strategy.targets.map((t) => t.asset),
    snapshot.positions.map((p) => p.asset),
    policy.allowedAssets,
  ])
    if (new Set(values).size !== values.length) throw Error("duplicate asset");
  const positions = new Map(snapshot.positions.map((p) => [p.asset, p]));
  if (
    positions.size !== strategy.targets.length ||
    strategy.targets.some(
      (t) => !positions.has(t.asset) || !policy.allowedAssets.includes(t.asset),
    )
  )
    throw Error("complete allowlisted target and position coverage required");
  if (
    strategy.targets.some((t) => t.weightBps > policy.maxAssetBps) ||
    strategy.targets.reduce((n, t) => n + t.weightBps, 0) > policy.maxTotalBps
  )
    throw Error("target allocation exceeds policy");
  const spendableNative =
    BigInt(snapshot.nativeBalanceWei) -
    BigInt(snapshot.gasReserveWei) -
    BigInt(snapshot.pendingNativeWei);
  if (spendableNative < 0n) throw Error("native reservations exceed balance");
  const nativeValue =
    (spendableNative * BigInt(snapshot.nativePriceMicros)) / 10n ** 18n;
  let value = nativeValue;
  for (const p of snapshot.positions) {
    if (BigInt(p.pending) > BigInt(p.balance))
      throw Error("reserved tokens exceed balance");
    value +=
      (BigInt(p.balance) * BigInt(p.priceMicros)) / 10n ** BigInt(p.decimals);
  }
  const items: PreviewItem[] = [];
  let buyBudget = 0n,
    turnover = 0n;
  for (const t of [...strategy.targets].sort((a, b) =>
    a.asset.localeCompare(b.asset),
  )) {
    const p = positions.get(t.asset)!,
      scale = 10n ** BigInt(p.decimals),
      price = BigInt(p.priceMicros);
    const current = (BigInt(p.balance) * price) / scale;
    const target = (value * BigInt(t.weightBps)) / 10000n;
    if (target === current) continue;
    const side = target > current ? "BUY" : "SELL";
    const delta = side === "BUY" ? target - current : current - target;
    const quantity = (delta * scale) / price;
    const referenceValue = (quantity * price) / scale;
    if (quantity === 0n || referenceValue === 0n) continue;
    if (side === "SELL" && quantity > BigInt(p.balance) - BigInt(p.pending))
      throw Error("required sale includes reserved tokens");
    if (side === "BUY") buyBudget += referenceValue;
    turnover += referenceValue;
    items.push({
      asset: t.asset,
      side,
      targetWeightBps: t.weightBps,
      referenceQuantity: quantity.toString(),
      referenceValueMicros: referenceValue.toString(),
    });
  }
  if (buyBudget > nativeValue)
    throw Error(
      "insufficient current buy budget; replan after confirmed sells",
    );
  if (turnover * 10000n > value * BigInt(policy.maxTurnoverBps))
    throw Error("turnover exceeds policy");
  const body = {
    version: "wallet-preview/1" as const,
    previewOnly: true as const,
    executed: false as const,
    agent: snapshot.agent,
    wallet: snapshot.wallet,
    chainId: snapshot.chainId,
    strategyHash: hash(strategy),
    policyHash: hash(policy),
    snapshotHash: hash(snapshot),
    evaluatedAt: now,
    validUntil: Math.min(
      strategy.validUntil,
      snapshot.observedAt + policy.maxSnapshotAgeMs,
    ),
    portfolioValueMicros: value.toString(),
    spendableNativeWei: spendableNative.toString(),
    buyValueMicros: buyBudget.toString(),
    turnoverValueMicros: turnover.toString(),
    items,
    requiredBeforeExecution: [
      "SIGNED_WALLET_APPLICABLE_STRATEGY",
      "ELIGIBLE_WORKER_AND_PROTOCOL_POLICY",
      "FRESH_CANONICAL_BALANCES",
      "MACHINE_CHECKABLE_CONDITIONS",
      "DEX_QUOTE_AND_SLIPPAGE",
      "GAS_AND_RESERVATION_RECHECK",
    ],
  };
  return { id: hash(body), ...body };
}
