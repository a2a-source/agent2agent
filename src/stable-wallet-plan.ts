import { z } from "zod";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import { investmentRiskPolicySchema } from "./investment-risk.js";
import type { PortfolioSnapshot } from "./portfolio-snapshot.js";
const time = z.number().int().nonnegative().safe();
const weight = time.max(10000);
export const stableAllocationPreviewSchema = z
  .object({
    version: z.literal("stable-allocation-preview/1"),
    epoch: z.string().min(1).max(128),
    chainId: time.positive(),
    createdAt: time,
    validUntil: time,
    targets: z.object({ BTC: weight, ETH: weight, BNB: weight }).strict(),
  })
  .strict();
const buckets = ["BTC", "ETH", "BNB"] as const;
type Bucket = (typeof buckets)[number];
interface Plan {
  id: string;
  inputHash: string;
  version: "stable-wallet-plan/1";
  snapshotId: string;
  agent: string;
  wallet: string;
  epoch: string;
  chainId: number;
  evaluatedAt: number;
  validUntil: number;
  previewOnly: true;
  executed: false;
  status: "READY" | "BLOCKED" | "NO_ACTION";
  phase: "REDUCE_FIRST" | "ACCUMULATE" | "NONE";
  reason: string;
  policy: z.infer<typeof investmentRiskPolicySchema>;
  strategy: z.infer<typeof stableAllocationPreviewSchema>;
  workerEligible: boolean;
  orders: { side: "BUY" | "SELL"; bucket: Bucket; notionalMicros: string }[];
}
/** Trusted local collector output -> durable reference plan. No signed QSP or execution authority implied. */
export class StableWalletPlanner {
  readonly policy: z.infer<typeof investmentRiskPolicySchema>;
  constructor(
    readonly db: Store,
    policy: unknown = {},
  ) {
    this.policy = investmentRiskPolicySchema.parse(policy);
    if (
      this.policy.maxUnderlyingBps > 2000 ||
      this.policy.maxVolatileBps > 6000 ||
      this.policy.maxOrderBuyBps > 1000 ||
      this.policy.maxCycleBuyBps > 1000
    )
      throw Error("stable wallet policy exceeds approved ceiling");
  }
  plan(
    snapshotId: string,
    raw: unknown,
    workerEligible: boolean,
    now: number,
  ): Plan {
    time.parse(now);
    z.boolean().parse(workerEligible);
    const strategy = stableAllocationPreviewSchema.parse(raw);
    const snapshot = this.db.get<PortfolioSnapshot>(
      "portfolio-snapshot",
      snapshotId,
    );
    if (!snapshot) throw Error("stored portfolio snapshot required");
    const id = hash([
      "stable-wallet-plan/1",
      snapshot.chainId,
      snapshot.wallet,
      strategy.epoch,
    ]);
    const inputHash = hash({
      snapshot,
      strategy,
      policy: this.policy,
      workerEligible,
    });
    return this.db.transaction(() => {
      const prior = this.db.get<Plan>("stable-wallet-plan", id);
      if (prior) {
        if (prior.inputHash !== inputHash) throw Error("wallet plan conflict");
        return prior;
      }
      const p: Plan = {
        id,
        inputHash,
        version: "stable-wallet-plan/1",
        snapshotId,
        agent: snapshot.agent,
        wallet: snapshot.wallet,
        epoch: strategy.epoch,
        chainId: snapshot.chainId,
        evaluatedAt: now,
        validUntil: Math.min(strategy.validUntil, snapshot.validUntil),
        previewOnly: true,
        executed: false,
        status: "BLOCKED",
        phase: "NONE",
        reason: "",
        policy: this.policy,
        strategy,
        workerEligible,
        orders: [],
      };
      const save = (reason: string) => {
        p.reason = reason;
        this.db.insert("stable-wallet-plan", id, p);
        return p;
      };
      const capture = this.db.get<any>("portfolio-capture", snapshot.requestId);
      if (capture?.status !== "DONE" || capture.snapshotId !== snapshot.id)
        return save("CAPTURE_NOT_CONFIRMED");
      if (strategy.chainId !== snapshot.chainId) return save("CHAIN_MISMATCH");
      if (
        now < strategy.createdAt ||
        now < snapshot.observedAt ||
        now >= p.validUntil ||
        strategy.validUntil <= strategy.createdAt
      )
        return save("DATA_EXPIRED_OR_FUTURE");
      const policy = this.policy,
        nav = BigInt(snapshot.navMicros),
        stable = BigInt(snapshot.stableValueMicros),
        available = BigInt(snapshot.availableStableMicros);
      const total = buckets.reduce(
        (n, b) => n + BigInt(snapshot.exposures[b]),
        0n,
      );
      if (
        total + stable !== nav ||
        available > stable ||
        buckets.some(
          (b) =>
            BigInt(snapshot.availableExposures[b]) >
            BigInt(snapshot.exposures[b]),
        )
      )
        return save("INCONSISTENT_SNAPSHOT");
      if (
        buckets.some((b) => strategy.targets[b] > policy.maxUnderlyingBps) ||
        buckets.reduce((n, b) => n + strategy.targets[b], 0) >
          policy.maxVolatileBps
      )
        return save("TARGET_EXCEEDS_POLICY");
      if (nav === 0n) {
        p.status = "NO_ACTION";
        return save("EMPTY_PORTFOLIO");
      }
      const target = Object.fromEntries(
        buckets.map((b) => [b, (nav * BigInt(strategy.targets[b])) / 10000n]),
      ) as Record<Bucket, bigint>;
      const reductions = buckets.filter(
        (b) => BigInt(snapshot.exposures[b]) > target[b],
      );
      const min = BigInt(policy.minTradeMicros);
      if (reductions.length) {
        p.phase = "REDUCE_FIRST";
        for (const b of reductions) {
          const needed = BigInt(snapshot.exposures[b]) - target[b],
            free = BigInt(snapshot.availableExposures[b]);
          const amount = needed < free ? needed : free;
          if (amount > 0n && amount >= min)
            p.orders.push({
              side: "SELL",
              bucket: b,
              notionalMicros: amount.toString(),
            });
        }
        if (!p.orders.length) return save("REDUCTION_UNAVAILABLE_OR_DUST");
        p.status = "READY";
        return save("REPLAN_AFTER_CONFIRMED_REDUCTIONS");
      }
      if (!workerEligible) return save("WORKER_REQUIRED_FOR_BUYS");
      const deficits = buckets.map((b) => ({
        bucket: b,
        amount: target[b] - BigInt(snapshot.exposures[b]),
      }));
      const wanted = deficits.reduce((n, d) => n + d.amount, 0n);
      if (wanted === 0n) {
        p.status = "NO_ACTION";
        return save("AT_TARGET");
      }
      const limit = (available * BigInt(policy.maxCycleBuyBps)) / 10000n;
      const budget = limit < wanted ? limit : wanted;
      const orderLimit = (available * BigInt(policy.maxOrderBuyBps)) / 10000n;
      for (const d of deficits) {
        const proportional = (budget * d.amount) / wanted,
          amount = proportional < orderLimit ? proportional : orderLimit;
        if (amount > 0n && amount >= min)
          p.orders.push({
            side: "BUY",
            bucket: d.bucket,
            notionalMicros: amount.toString(),
          });
      }
      p.phase = "ACCUMULATE";
      if (!p.orders.length) {
        p.status = "NO_ACTION";
        return save("BUY_BUDGET_BELOW_ECONOMIC_FLOOR");
      }
      p.status = "READY";
      return save("REFERENCE_PLAN_REQUIRES_EXECUTION_CHECKS");
    });
  }
}
