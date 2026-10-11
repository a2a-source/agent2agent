import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import { MIN_STAKE } from "./money.js";
import type { Agent } from "./agents.js";
import type { Epoch } from "./epochs.js";
import type { ChainState } from "./watcher.js";
import type { TxRecord } from "./chain.js";
import { verifyPublishedEpoch } from "./confirmation.js";
import { qspV2Schema } from "./qsp-v2.js";
import { validateStableNetworkAllocation } from "./stable-network-allocation.js";
import {
  PortfolioCollector,
  portfolioRegistrySchema,
} from "./portfolio-snapshot.js";
import { ConfirmedStablePlans } from "./confirmed-stable-plans.js";
const positive = z.number().int().positive().safe();
export const planningConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    registry: portfolioRegistrySchema.nullable().default(null),
    maxAttempts: positive.max(10).default(3),
    retryMs: positive.max(86400000).default(30000),
    leaseMs: positive.max(86400000).default(120000),
    maxJobsPerTick: positive.max(32).default(4),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.enabled && !v.registry)
      c.addIssue({ code: "custom", message: "planning registry required" });
  });
const optionsSchema = z.object({
  maxAttempts: positive.max(10),
  retryMs: positive.max(86400000),
  leaseMs: positive.max(86400000),
  maxJobsPerTick: positive.max(32),
  gasReserveWei: z.string().regex(/^(0|[1-9][0-9]*)$/),
});
interface Job {
  id: string;
  epoch: string;
  agent: string;
  wallet: string;
  deadline: number;
  configHash: string;
  status: "PENDING" | "RUNNING" | "RETRY" | "DONE" | "FAILED" | "EXPIRED";
  attempts: number;
  nextAt: number;
  owner?: string;
  leaseUntil?: number;
  reason?: string;
  planId?: string;
}
interface Attempt {
  id: string;
  jobId: string;
  number: number;
  captureId: string;
  startedAt: number;
  status: string;
  snapshotId?: string;
  reason?: string;
  finishedAt?: number;
}
export class InvestmentPlanning {
  private busy = false;
  readonly options: z.infer<typeof optionsSchema>;
  readonly configHash: string;
  constructor(
    readonly db: Store,
    readonly collector: PortfolioCollector,
    readonly consumer: ConfirmedStablePlans,
    options: unknown,
    readonly clock = Date.now,
  ) {
    this.options = optionsSchema.parse(options);
    if (collector.registry.chainId !== consumer.chainId)
      throw Error("planning chain mismatch");
    this.configHash = hash({
      registry: collector.registry,
      policy: consumer.planner.policy,
      options: this.options,
    });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.discover();
      let count = 0;
      for (const job of this.db
        .all<Job>("investment-planning-job")
        .filter((j) => !["DONE", "FAILED", "EXPIRED"].includes(j.status))
        .sort(
          (a, b) =>
            a.deadline - b.deadline ||
            a.nextAt - b.nextAt ||
            a.id.localeCompare(b.id),
        )) {
        if (count >= this.options.maxJobsPerTick) break;
        const claim = this.claim(job.id);
        if (!claim) continue;
        count++;
        await this.run(claim.job, claim.attempt);
      }
    } finally {
      this.busy = false;
    }
  }
  private discover() {
    const now = this.clock();
    for (const epoch of this.db
      .all<Epoch>("epoch")
      .filter((e) => e.status === "PUBLISHED")) {
      let deadline = 0,
        reason = "NO_VALID_STABLE_ALLOCATION";
      try {
        const q = qspV2Schema.parse(epoch.output),
          a = q.masterSummary.stableNetworkAllocation;
        if (
          !a ||
          !epoch.confirmationRequired ||
          !verifyPublishedEpoch(this.consumer.chainId, epoch) ||
          q.context.chainId !== this.consumer.chainId
        )
          throw Error("invalid");
        const maxAge = q.context.policy.dataMaxAgeMs ?? 600000;
        const checked = validateStableNetworkAllocation(
          a,
          q.context,
          q.reports,
          now,
          maxAge,
        );
        deadline = Math.min(
          q.validUntil,
          q.dataAt + maxAge,
          q.context.at + maxAge,
          checked.validUntil,
        );
        if (
          now < q.createdAt ||
          now < (epoch.confirmation?.confirmedAt ?? Infinity) ||
          now >= deadline
        )
          throw Error("expired");
        reason = "CONFIRMED_REFERENCE_PLANNING";
      } catch {
        deadline = 0;
      }
      const epochKey = hash([this.consumer.chainId, epoch.id]);
      const priorEpoch = this.db.get<{ roster?: Agent[] }>(
        "investment-planning-epoch",
        epochKey,
      );
      const roster =
        priorEpoch?.roster ??
        (deadline ? this.db.all<Agent>("agent") : undefined);
      this.db.put("investment-planning-epoch", epochKey, {
        epoch: epoch.id,
        chainId: this.consumer.chainId,
        status: deadline ? "ELIGIBLE" : "SKIPPED",
        reason,
        roster,
      });
      if (!deadline) continue;
      this.db.transaction(() => {
        for (const agent of roster ?? []) {
          const id = hash([
            "investment-planning/1",
            this.consumer.chainId,
            epoch.id,
            agent.id,
          ]);
          if (!this.db.get("investment-planning-job", id))
            this.db.insert("investment-planning-job", id, {
              id,
              epoch: epoch.id,
              agent: agent.id,
              wallet: agent.wallet.toLowerCase(),
              deadline,
              configHash: this.configHash,
              status: "PENDING",
              attempts: 0,
              nextAt: now,
            } satisfies Job);
        }
      });
    }
  }
  private claim(id: string) {
    return this.db.transaction(() => {
      const j = this.db.get<Job>("investment-planning-job", id)!,
        now = this.clock();
      if (["DONE", "FAILED", "EXPIRED"].includes(j.status)) return;
      if (j.status === "RUNNING" && (j.leaseUntil ?? 0) > now) return;
      // Recover an already committed consumer outcome even after its source expired.
      const attempts = this.db
        .all<Attempt>("investment-planning-attempt")
        .filter((a) => a.jobId === id);
      const done = this.db
        .all<any>("stable-qsp-consumption")
        .find(
          (c) =>
            !!c.planId &&
            c.epochId === j.epoch &&
            attempts.some((a) => a.snapshotId === c.snapshotId),
        );
      if (done) {
        this.db.put("investment-planning-job", id, {
          ...j,
          status: "DONE",
          leaseUntil: 0,
          reason: "RECOVERED_COMMITTED_PLAN",
          planId: done.planId,
        });
        return;
      }
      if (j.status === "RUNNING")
        for (const a of attempts.filter((a) => a.status === "RUNNING"))
          this.db.put("investment-planning-attempt", a.id, {
            ...a,
            status: "UNKNOWN",
            finishedAt: now,
            reason: "LEASE_EXPIRED",
          });
      if (now >= j.deadline) {
        this.db.put("investment-planning-job", id, {
          ...j,
          status: "EXPIRED",
          leaseUntil: 0,
          reason: "QSP_WINDOW_CLOSED",
        });
        return;
      }
      if (
        j.configHash !== this.configHash ||
        j.attempts >= this.options.maxAttempts
      ) {
        this.db.put("investment-planning-job", id, {
          ...j,
          status: "FAILED",
          leaseUntil: 0,
          reason:
            j.configHash !== this.configHash
              ? "PLANNING_CONFIG_CHANGED"
              : "ATTEMPTS_EXHAUSTED",
        });
        return;
      }
      if (now < j.nextAt) return;
      // Oracle outages must not spend attempts, but recovery/expiry above still run.
      if (this.consumer.minimumCompute() === undefined) return;
      const job: Job = {
        ...j,
        status: "RUNNING",
        attempts: j.attempts + 1,
        owner: randomUUID(),
        leaseUntil: now + this.options.leaseMs,
      };
      const attempt: Attempt = {
        id: hash([id, job.attempts]),
        jobId: id,
        number: job.attempts,
        captureId: hash(["planning-capture/1", id, job.attempts]),
        startedAt: now,
        status: "RUNNING",
      };
      this.db.put("investment-planning-job", id, job);
      this.db.insert("investment-planning-attempt", attempt.id, attempt);
      return { job, attempt };
    });
  }
  private owns(job: Job) {
    const current = this.db.get<Job>("investment-planning-job", job.id);
    return (
      current?.status === "RUNNING" &&
      current.owner === job.owner &&
      (current.leaseUntil ?? 0) > this.clock()
    );
  }
  private finish(job: Job, attempt: Attempt, reason: string, planId?: string) {
    if (!this.owns(job)) return;
    const now = this.clock(),
      status = planId
        ? "DONE"
        : now >= job.deadline
          ? "EXPIRED"
          : job.attempts >= this.options.maxAttempts
            ? "FAILED"
            : "RETRY";
    this.db.put("investment-planning-attempt", attempt.id, {
      ...attempt,
      status: planId ? "DONE" : "FAILED",
      reason,
      finishedAt: now,
    });
    this.db.put("investment-planning-job", job.id, {
      ...job,
      status,
      reason,
      planId,
      leaseUntil: 0,
      nextAt: Math.min(
        job.deadline,
        now + this.options.retryMs * 2 ** (job.attempts - 1),
      ),
    });
  }
  private async run(job: Job, attempt: Attempt) {
    try {
      const agent = this.db.get<Agent>("agent", job.agent),
        state = this.db.get<ChainState>("chain-state", job.agent),
        now = this.clock(),
        minimum = this.consumer.minimumCompute(),
        available = this.consumer.budget.available(job.agent);
      const pending = this.db
        .all<TxRecord>("transaction")
        .filter(
          (t) => t.sender.toLowerCase() === job.wallet && t.state === "READY",
        )
        .map((t) => t.id);
      const lock = this.db.get<{ expires: number }>("sender-lock", job.wallet);
      const eligible =
        agent?.wallet.toLowerCase() === job.wallet &&
        agent.launch === "CONFIRMED" &&
        !agent.jailed &&
        agent.autoStake &&
        state?.known &&
        state.observedAt <= now &&
        now - state.observedAt <= this.consumer.stateMaxAgeMs &&
        BigInt(state.bonded) >= MIN_STAKE &&
        BigInt(state.exit) === 0n &&
        minimum !== undefined &&
        minimum > 0n &&
        available >= minimum;
      this.db.insert("investment-planning-check", attempt.id, {
        jobId: job.id,
        agent,
        state,
        minimumCompute: minimum?.toString() ?? null,
        computeAvailable: available.toString(),
        pending,
        lock,
        at: now,
        eligible: !!eligible,
      });
      if (!eligible || pending.length || (lock && lock.expires > now)) {
        this.db.transaction(() =>
          this.finish(
            job,
            attempt,
            !eligible ? "WORKER_NOT_READY" : "WALLET_BUSY",
          ),
        );
        return;
      }
      const collection = this.collector.collect({
        id: attempt.captureId,
        agent: job.agent,
        wallet: job.wallet,
        gasReserveWei: this.options.gasReserveWei,
        reservationSource: attempt.id,
        reserved: Object.fromEntries(
          this.collector.registry.assets.map((a) => [a.asset, "0"]),
        ),
      });
      // Bound the coordinator wait even when a provider never settles. Late
      // collection may retain read-only audit records but cannot consume QSP.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const snapshot = await Promise.race([
        collection,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("collection deadline exceeded")),
            Math.max(1, Math.min(job.deadline, job.leaseUntil!) - this.clock()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      this.db.transaction(() => {
        if (!this.owns(job)) return;
        attempt = { ...attempt, snapshotId: snapshot.id };
        this.db.put("investment-planning-attempt", attempt.id, attempt);
        const result = this.consumer.consume(
          job.epoch,
          snapshot.id,
          this.clock(),
        );
        this.finish(job, attempt, result.reason, result.planId);
      });
    } catch {
      this.db.transaction(() =>
        this.finish(job, attempt, "PLANNING_ATTEMPT_FAILED"),
      );
    }
  }
}
