import {
  readObservationSnapshot,
  validateRoundCashflowProof,
} from "./round-observation-evidence.js";
export { readObservationSnapshot } from "./round-observation-evidence.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isAddress, ZeroAddress } from "ethers";
import { hash } from "./protocol.js";
import { Store } from "./store.js";
import type { Epoch } from "./epochs.js";
import type { Agent } from "./agents.js";
import type { PortfolioSnapshot } from "./portfolio-snapshot.js";
import {
  PerformanceLedger,
  observationBoundarySchema,
} from "./performance-ledger.js";
export type { ObservationBoundary } from "./performance-ledger.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().safe();
const identity = z
  .object({
    agentId: z.string().min(1).max(160),
    wallet: z
      .string()
      .refine(isAddress)
      .transform((x) => x.toLowerCase())
      .refine((x) => x !== ZeroAddress),
  })
  .strict();
export type ObservationRosterMember = z.infer<typeof identity>;
const walletSchema = identity.extend({
  openingSnapshotId: digest.nullable(),
  closingSnapshotId: digest.nullable(),
  proofIds: z.array(digest).max(64),
  captureAttemptIds: z.array(z.string()).max(16),
  missingReasons: z.array(z.string().min(1).max(240)).max(32),
});
export const roundObservationInputSchema = z
  .object({
    chainId: time.positive(),
    roundId: z.string().min(1).max(160),
    sourceStatus: z.enum(["PUBLISHED", "FAILED"]),
    terminalAt: time.nullable(),
    observedAt: time,
    roster: z.array(identity).max(1000),
    rosterComplete: z.boolean(),
    predecessorId: digest.nullable(),
    registryHash: digest.nullable(),
    configHash: digest,
    openingBoundary: observationBoundarySchema.nullable(),
    closingBoundary: observationBoundarySchema.nullable(),
    lifecycle: z.enum(["PENDING", "COMPLETE"]),
    wallets: z.array(walletSchema).max(1000),
    missingReasons: z.array(z.string().min(1).max(240)).max(32),
  })
  .strict();
export type RoundObservationInput = z.input<typeof roundObservationInputSchema>;
export type RoundObservation = z.output<typeof roundObservationInputSchema> & {
  version: "round-observation/1";
  id: string;
  supersedes: string | null;
  revision: number;
  currency: "micro-USD";
  scope: "REGISTERED_ASSETS_AND_NATIVE_EOA";
};
export interface TerminalObservationRoster {
  roundId: string;
  sourceStatus: "PUBLISHED" | "FAILED";
  terminalAt: number | null;
  roster: ObservationRosterMember[];
  rosterComplete: boolean;
}
export function freezeTerminalObservationRoster(db: Store, epoch: Epoch): void {
  if (epoch.status !== "PUBLISHED" && epoch.status !== "FAILED") return;
  if (db.get("round-observation-terminal", epoch.id)) return;
  const terminalAt = epoch.finishedAt ?? null;
  const record: TerminalObservationRoster = {
    roundId: epoch.id,
    sourceStatus: epoch.status,
    terminalAt,
    roster: db
      .all<Agent>("agent")
      .filter((a) => terminalAt !== null && a.createdAt <= terminalAt)
      .map((a) => identity.parse({ agentId: a.id, wallet: a.wallet }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId)),
    rosterComplete: terminalAt !== null,
  };
  db.insert("round-observation-terminal", epoch.id, record);
}
export function observationProjection(db: Store, input: RoundObservationInput) {
  const x = roundObservationInputSchema.parse(input);
  if (
    new Set(x.roster.map((a) => a.agentId)).size !== x.roster.length ||
    new Set(x.roster.map((a) => a.wallet)).size !== x.roster.length ||
    new Set(x.wallets.map((a) => a.agentId)).size !== x.wallets.length ||
    x.wallets.length !== x.roster.length
  )
    throw Error("OBSERVATION_ROSTER_INVALID");
  return x.wallets.map((w) => {
    if (!x.roster.some((r) => r.agentId === w.agentId && r.wallet === w.wallet))
      throw Error("OBSERVATION_ROSTER_INVALID");
    const read = (id: string | null, boundary: typeof x.openingBoundary) => {
      if (!id) return null;
      const s = readObservationSnapshot(db, id);
      const capture = db.get<any>("portfolio-capture", s.requestId);
      if (
        capture.mode !== "round-observation" ||
        hash(capture.boundary) !== hash(boundary)
      )
        throw Error("OBSERVATION_SNAPSHOT_TIME_MISMATCH");
      if (
        !boundary ||
        s.agent !== w.agentId ||
        s.wallet !== w.wallet ||
        s.chainId !== x.chainId ||
        s.registryHash !== x.registryHash ||
        s.blockNumber !== boundary.blockNumber ||
        s.blockHash.toLowerCase() !== boundary.blockHash.toLowerCase() ||
        s.holdings.some((h) => h.gasExcluded !== "0" || h.reserved !== "0") ||
        s.reservationSource !== "round-observation"
      )
        throw Error("OBSERVATION_SNAPSHOT_BOUNDARY_MISMATCH");
      return s;
    };
    const opening = read(w.openingSnapshotId, x.openingBoundary),
      closing = read(w.closingSnapshotId, x.closingBoundary);
    let known = false;
    for (const id of w.proofIds) {
      if (
        validateRoundCashflowProof(
          db,
          id,
          w.openingSnapshotId,
          w.closingSnapshotId,
        ) === "KNOWN"
      )
        known = true;
    }
    if (
      known &&
      (!opening ||
        !closing ||
        !x.openingBoundary ||
        !x.closingBoundary ||
        x.closingBoundary.blockNumber <= x.openingBoundary.blockNumber ||
        x.closingBoundary.blockTimeMs <= x.openingBoundary.blockTimeMs)
    )
      throw Error("OBSERVATION_INVALID_KNOWN_INTERVAL");
    return {
      agentId: w.agentId,
      openingNAV: opening?.navMicros ?? null,
      closingNAV: closing?.navMicros ?? null,
      netCapitalFlow: known ? "0" : null,
      cashflowComplete: known,
      hasCapitalFlows: known ? false : null,
      missingReasons: w.missingReasons,
      investments: [],
      openingSnapshotId: w.openingSnapshotId,
      closingSnapshotId: w.closingSnapshotId,
      proofIds: w.proofIds,
      navDelta:
        opening && closing
          ? (BigInt(closing.navMicros) - BigInt(opening.navMicros)).toString()
          : null,
    };
  });
}
export function publishRoundObservation(
  db: Store,
  input: RoundObservationInput,
  expectedHead: string | null,
): RoundObservation {
  const x = roundObservationInputSchema.parse(input),
    key = hash([x.chainId, x.roundId]);
  return db.transaction(() => {
    const head = db.get<{ id: string }>("round-observation-head", key),
      current = head
        ? db.get<RoundObservation>("round-observation", head.id)
        : undefined;
    const replay = db.all<RoundObservation>("round-observation").find((r) => {
      const { id, version, supersedes, revision, currency, scope, ...body } = r;
      return hash(body) === hash(x);
    });
    if (replay) return replay;
    if ((head?.id ?? null) !== expectedHead)
      throw Error("OBSERVATION_REVISION_CONFLICT");
    const perAgent = observationProjection(db, x);
    const body = {
      ...x,
      version: "round-observation/1" as const,
      currency: "micro-USD" as const,
      scope: "REGISTERED_ASSETS_AND_NATIVE_EOA" as const,
      revision: (current?.revision ?? 0) + 1,
      supersedes: expectedHead,
    };
    const record = { ...body, id: hash(body) },
      ledger = new PerformanceLedger(db),
      prior = ledger.latest(x.roundId, x.chainId, "micro-USD");
    ledger.recordRound({
      version: "performance-input/2",
      currency: "micro-USD",
      roundId: x.roundId,
      chainId: x.chainId,
      observationId: record.id,
      sourceStatus: x.sourceStatus,
      terminalAt: x.terminalAt,
      rosterComplete: x.rosterComplete,
      openingBoundary: x.openingBoundary,
      closingBoundary: x.closingBoundary,
      windowStartMs: x.openingBoundary?.blockTimeMs ?? null,
      windowEndMs: x.closingBoundary?.blockTimeMs ?? null,
      observedAt: x.observedAt,
      roster: x.roster,
      perAgent,
      ...(prior ? { supersedes: prior.revisionHash } : {}),
    });
    db.insert("round-observation", record.id, record);
    db.put("round-observation-head", key, { id: record.id });
    return record;
  });
}

export interface RoundObservationOptions {
  maxWalletsPerTick: number;
  maxAttempts: number;
  retryMs: number;
  leaseMs: number;
  deadlineMs: number;
}
export const roundObservationDefaults: RoundObservationOptions = {
  maxWalletsPerTick: 3,
  maxAttempts: 3,
  retryMs: 30000,
  leaseMs: 120000,
  deadlineMs: 600000,
};
export interface RoundObservationAdapters {
  collector: import("./portfolio-snapshot.js").PortfolioCollector;
  selectBoundary(
    terminalAt: number,
    afterBlock: number | null,
  ): Promise<import("./performance-ledger.js").ObservationBoundary | null>;
  settlementReady(epoch: Epoch): boolean;
  prove(
    openingSnapshotId: string,
    closingSnapshotId: string,
  ): Promise<import("./round-cashflow.js").RoundCashflowResult>;
}
interface WalletWork {
  captureAttempts: number;
  proofAttempts: number;
  done: boolean;
  captureId?: string;
  nextAt: number;
}
export interface RoundObservationJob {
  id: string;
  chainId: number;
  roundId: string;
  status: "PENDING" | "RUNNING" | "RETRY" | "COMPLETE";
  headId: string;
  predecessorRoundId: string | null;
  input: RoundObservationInput;
  configHash: string;
  discoveredAt: number;
  deadline: number;
  nextAt: number;
  pinAttempts: number;
  deadlinePinAttempted?: boolean;
  deadlinePinGeneration?: number;
  generation: number;
  owner?: string;
  leaseUntil?: number;
  walletWork: Record<string, WalletWork>;
}
/** Observation-only durable coordinator. No signer, consumer, planner or reservation capability. */
export class RoundObservationService {
  readonly options: RoundObservationOptions;
  readonly configHash: string;
  private busy = false;
  constructor(
    readonly db: Store,
    readonly chainId: number,
    readonly adapters: RoundObservationAdapters | undefined,
    options: Partial<RoundObservationOptions> = {},
    readonly clock = Date.now,
  ) {
    this.options = { ...roundObservationDefaults, ...options };
    for (const value of Object.values(this.options))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw Error("INVALID_OBSERVATION_OPTIONS");
    if (adapters && adapters.collector.registry.chainId !== chainId)
      throw Error("OBSERVATION_CHAIN_MISMATCH");
    const config = {
      chainId,
      registry: adapters?.collector.registry ?? null,
      options: this.options,
    };
    this.configHash = hash(config);
    if (!db.get("round-observation-config", this.configHash))
      db.insert("round-observation-config", this.configHash, config);
  }
  private discover() {
    const now = this.clock(),
      epochs = this.db
        .all<Epoch>("epoch")
        .filter(
          (e) =>
            (e.status === "PUBLISHED" || e.status === "FAILED") &&
            (e.finishedAt === undefined || e.finishedAt <= now),
        )
        .sort(
          (a, b) =>
            (a.finishedAt ?? Number.MAX_SAFE_INTEGER) -
              (b.finishedAt ?? Number.MAX_SAFE_INTEGER) ||
            a.id.localeCompare(b.id),
        );
    this.db.transaction(() => {
      let predecessor: string | null = null;
      for (const e of epochs) {
        const key = hash([this.chainId, e.id]);
        if (this.db.get("round-observation-job", key)) {
          predecessor = e.id;
          continue;
        }
        const frozen = this.db.get<TerminalObservationRoster>(
          "round-observation-terminal",
          e.id,
        );
        const roster =
          frozen?.roster ??
          this.db
            .all<Agent>("agent")
            .filter(
              (a) => e.finishedAt !== undefined && a.createdAt <= e.finishedAt,
            )
            .map((a) => identity.parse({ agentId: a.id, wallet: a.wallet }))
            .sort((a, b) => a.agentId.localeCompare(b.agentId));
        const historical = e !== epochs.at(-1),
          reasons = [
            ...(!frozen?.rosterComplete ? ["ROSTER_HISTORY_INCOMPLETE"] : []),
            ...(e.finishedAt === undefined ? ["ROUND_END_TIME_UNKNOWN"] : []),
            ...(historical ? ["HISTORIC_BOUNDARY_UNAVAILABLE"] : []),
            ...(!this.adapters ? ["OBSERVATION_ADAPTER_UNAVAILABLE"] : []),
          ];
        const prior = predecessor
          ? this.db.get<{ id: string }>(
              "round-observation-head",
              hash([this.chainId, predecessor]),
            )
          : undefined;
        const input: RoundObservationInput = {
          chainId: this.chainId,
          roundId: e.id,
          sourceStatus: e.status as "PUBLISHED" | "FAILED",
          terminalAt: e.finishedAt ?? null,
          observedAt: now,
          roster,
          rosterComplete: frozen?.rosterComplete ?? false,
          predecessorId: prior?.id ?? null,
          registryHash: this.adapters
            ? hash(this.adapters.collector.registry)
            : null,
          configHash: this.configHash,
          openingBoundary: null,
          closingBoundary: null,
          lifecycle: "PENDING",
          wallets: roster.map((r) => ({
            ...r,
            openingSnapshotId: null,
            closingSnapshotId: null,
            proofIds: [],
            captureAttemptIds: [],
            missingReasons: [...reasons, "OPENING_BASELINE_UNAVAILABLE"],
          })),
          missingReasons: reasons,
        };
        const first = publishRoundObservation(this.db, input, null),
          job: RoundObservationJob = {
            id: key,
            chainId: this.chainId,
            roundId: e.id,
            status: "PENDING",
            headId: first.id,
            predecessorRoundId: predecessor,
            input,
            configHash: this.configHash,
            discoveredAt: now,
            deadline: now + this.options.deadlineMs,
            nextAt: now,
            pinAttempts: 0,
            generation: 0,
            walletWork: Object.fromEntries(
              roster.map((r) => [
                r.agentId,
                {
                  captureAttempts: 0,
                  proofAttempts: 0,
                  done:
                    historical || !this.adapters || e.finishedAt === undefined,
                  nextAt: now,
                },
              ]),
            ),
          };
        this.db.insert("round-observation-job", key, job);
        if (historical || !this.adapters || e.finishedAt === undefined)
          this.complete(job);
        predecessor = e.id;
      }
    });
  }
  private closeRunningAttempts(job: RoundObservationJob, reason: string) {
    for (const attempt of this.db.all<{
      id: string;
      jobId: string;
      status: string;
    }>("round-observation-attempt")) {
      if (attempt.jobId === job.id && attempt.status === "RUNNING")
        this.db.put("round-observation-attempt", attempt.id, {
          ...attempt,
          status: "FAILED",
          reason,
          finishedAt: this.clock(),
        });
    }
  }
  private complete(job: RoundObservationJob, reason?: string) {
    if (job.status === "RUNNING" && !this.owns(job)) return;
    if (reason) this.closeRunningAttempts(job, reason);
    if (reason) {
      job.input.missingReasons = [
        ...new Set([...job.input.missingReasons, reason]),
      ];
      for (const w of job.input.wallets)
        if (!job.walletWork[w.agentId]?.done)
          w.missingReasons = [...new Set([...w.missingReasons, reason])];
    }
    job.input.lifecycle = "COMPLETE";
    job.input.observedAt = this.clock();
    const final = publishRoundObservation(this.db, job.input, job.headId);
    job.headId = final.id;
    job.status = "COMPLETE";
    delete job.owner;
    delete job.leaseUntil;
    this.db.put("round-observation-job", job.id, job);
  }
  private owns(job: RoundObservationJob) {
    const current = this.db.get<RoundObservationJob>(
      "round-observation-job",
      job.id,
    );
    return (
      current?.owner === job.owner &&
      current?.generation === job.generation &&
      current?.status === "RUNNING" &&
      (current.leaseUntil ?? 0) > this.clock()
    );
  }
  private canAdvance(job: RoundObservationJob) {
    if (!this.owns(job)) return false;
    const finalOpportunity =
      job.deadlinePinAttempted && job.deadlinePinGeneration === job.generation;
    if (this.clock() >= job.deadline && !finalOpportunity) {
      this.complete(job, "OBSERVATION_DEADLINE_EXHAUSTED");
      return false;
    }
    return true;
  }
  private save(job: RoundObservationJob) {
    if (!this.owns(job)) return false;
    this.db.put("round-observation-job", job.id, job);
    return true;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.discover();
      let remaining = this.options.maxWalletsPerTick;
      const jobs = this.db
        .all<RoundObservationJob>("round-observation-job")
        .filter((j) => j.chainId === this.chainId && j.status !== "COMPLETE")
        .sort(
          (a, b) =>
            a.discoveredAt - b.discoveredAt ||
            a.roundId.localeCompare(b.roundId),
        );
      for (const candidate of jobs) {
        if (remaining <= 0) break;
        const job = this.db.transaction(() => {
          const j = this.db.get<RoundObservationJob>(
            "round-observation-job",
            candidate.id,
          )!;
          const now = this.clock();
          if (
            j.status === "COMPLETE" ||
            j.nextAt > now ||
            (j.owner && (j.leaseUntil ?? 0) > now)
          )
            return null;
          // A fresh claimant, never the expired owner, closes abandoned coordination attempts.
          if (j.owner)
            this.closeRunningAttempts(j, "OBSERVATION_LEASE_EXPIRED");
          j.generation++;
          j.owner = randomUUID();
          j.leaseUntil = now + this.options.leaseMs;
          j.status = "RUNNING";
          this.db.put("round-observation-job", j.id, j);
          return j;
        });
        if (!job) continue;
        try {
          if (job.configHash !== this.configHash) {
            this.complete(job, "OBSERVATION_CONFIG_CHANGED");
            continue;
          }
          if (this.clock() >= job.deadline) {
            if (
              !job.input.closingBoundary &&
              !job.deadlinePinAttempted &&
              job.input.missingReasons.includes("WAITING_EXECUTION_BOUNDARY")
            ) {
              job.deadlinePinAttempted = true;
              job.deadlinePinGeneration = job.generation;
              job.input.missingReasons.push("UNSETTLED_BOUNDARY_AT_DEADLINE");
              this.save(job);
            } else {
              this.complete(job, "OBSERVATION_DEADLINE_EXHAUSTED");
              continue;
            }
          }
          const adapter = this.adapters!;
          if (!job.input.closingBoundary) {
            const epoch = this.db.get<Epoch>("epoch", job.roundId)!;
            if (!job.deadlinePinAttempted && !adapter.settlementReady(epoch)) {
              job.nextAt = this.clock() + this.options.retryMs;
              job.input.missingReasons = [
                ...new Set([
                  ...job.input.missingReasons,
                  "WAITING_EXECUTION_BOUNDARY",
                ]),
              ];
              continue;
            }
            const priorHead = job.predecessorRoundId
              ? this.db.get<{ id: string }>(
                  "round-observation-head",
                  hash([this.chainId, job.predecessorRoundId]),
                )
              : undefined;
            const prior = priorHead
              ? this.db.get<RoundObservation>("round-observation", priorHead.id)
              : undefined;
            if (prior?.lifecycle === "PENDING") {
              job.nextAt = this.clock() + this.options.retryMs;
              continue;
            }
            job.input.predecessorId = prior?.id ?? null;
            const compatible =
              prior?.registryHash === job.input.registryHash &&
              prior?.scope === "REGISTERED_ASSETS_AND_NATIVE_EOA";
            job.input.openingBoundary = compatible
              ? (prior?.closingBoundary ?? null)
              : null;
            if (job.pinAttempts >= this.options.maxAttempts) {
              this.complete(job, "BOUNDARY_ATTEMPTS_EXHAUSTED");
              continue;
            }
            job.pinAttempts++;
            this.save(job);
            const attemptId = hash([job.id, "pin", job.pinAttempts]);
            this.db.insert("round-observation-attempt", attemptId, {
              id: attemptId,
              jobId: job.id,
              phase: "pin",
              number: job.pinAttempts,
              status: "RUNNING",
              startedAt: this.clock(),
            });
            let boundary;
            try {
              boundary = await adapter.selectBoundary(
                job.input.terminalAt!,
                job.input.openingBoundary?.blockNumber ?? null,
              );
            } catch {
              if (!this.canAdvance(job)) continue;
              this.db.put("round-observation-attempt", attemptId, {
                id: attemptId,
                jobId: job.id,
                phase: "pin",
                number: job.pinAttempts,
                status: "FAILED",
                reason: "BOUNDARY_RPC_UNAVAILABLE",
              });
              job.nextAt = this.clock() + this.options.retryMs;
              continue;
            }
            if (!this.canAdvance(job)) continue;
            const parsedBoundary =
              observationBoundarySchema.safeParse(boundary);
            if (boundary && !parsedBoundary.success) {
              this.db.put("round-observation-attempt", attemptId, {
                ...this.db.get<object>("round-observation-attempt", attemptId),
                status: "FAILED",
                reason: "INVALID_BOUNDARY",
                finishedAt: this.clock(),
              });
              job.nextAt = this.clock() + this.options.retryMs;
              job.input.missingReasons = [
                ...new Set([...job.input.missingReasons, "INVALID_BOUNDARY"]),
              ];
              continue;
            }
            if (
              !boundary ||
              boundary.blockTimeMs < job.input.terminalAt! ||
              boundary.blockTimeMs > this.clock() ||
              (job.input.openingBoundary &&
                boundary.blockNumber <= job.input.openingBoundary.blockNumber)
            ) {
              this.db.put("round-observation-attempt", attemptId, {
                ...this.db.get<object>("round-observation-attempt", attemptId),
                status: "FAILED",
                reason: "NON_ADVANCING_BOUNDARY",
                finishedAt: this.clock(),
              });
              job.nextAt = this.clock() + this.options.retryMs;
              job.input.missingReasons = [
                ...new Set([
                  ...job.input.missingReasons,
                  "NON_ADVANCING_BOUNDARY",
                ]),
              ];
              continue;
            }
            job.input.closingBoundary =
              observationBoundarySchema.parse(boundary);
            this.db.put("round-observation-attempt", attemptId, {
              id: attemptId,
              jobId: job.id,
              phase: "pin",
              number: job.pinAttempts,
              status: "DONE",
              boundary,
            });
            for (const w of job.input.wallets) {
              const before = compatible
                ? prior?.wallets.find(
                    (a) => a.agentId === w.agentId && a.wallet === w.wallet,
                  )
                : undefined;
              w.openingSnapshotId = before?.closingSnapshotId ?? null;
              if (w.openingSnapshotId)
                w.missingReasons = w.missingReasons.filter(
                  (r) => r !== "OPENING_BASELINE_UNAVAILABLE",
                );
              if (prior && !compatible)
                w.missingReasons.push("REGISTRY_BASELINE_RESET");
            }
            this.save(job);
          }
          for (const w of job.input.wallets) {
            if (remaining <= 0 || !this.canAdvance(job)) break;
            const work = job.walletWork[w.agentId]!;
            if (work.done || work.nextAt > this.clock()) continue;
            remaining--;
            if (!w.closingSnapshotId) {
              // Reuse only a completed capture after crash; partial reads always get a fresh identity.
              const priorCapture = work.captureId
                ? this.db.get<any>(
                    "portfolio-capture",
                    hash([this.chainId, work.captureId]),
                  )
                : undefined;
              if (priorCapture?.status === "DONE") {
                w.closingSnapshotId = priorCapture.snapshotId;
              } else {
                if (work.captureAttempts >= this.options.maxAttempts) {
                  work.done = true;
                  w.missingReasons.push("CAPTURE_ATTEMPTS_EXHAUSTED");
                  continue;
                }
                work.captureAttempts++;
                work.captureId = hash([
                  job.id,
                  w.agentId,
                  "capture",
                  work.captureAttempts,
                ]);
                w.captureAttemptIds.push(work.captureId);
                this.save(job);
                this.db.insert("round-observation-attempt", work.captureId, {
                  id: work.captureId,
                  jobId: job.id,
                  agentId: w.agentId,
                  phase: "capture",
                  number: work.captureAttempts,
                  status: "RUNNING",
                  startedAt: this.clock(),
                });
                try {
                  const s = await adapter.collector.collectAt(
                    {
                      id: work.captureId,
                      agent: w.agentId,
                      wallet: w.wallet,
                      gasReserveWei: "0",
                      reservationSource: "round-observation",
                      reserved: Object.fromEntries(
                        adapter.collector.registry.assets.map((a) => [
                          a.asset,
                          "0",
                        ]),
                      ),
                    },
                    job.input.closingBoundary!,
                  );
                  if (!this.canAdvance(job)) break;
                  w.closingSnapshotId = s.id;
                  this.db.put("round-observation-attempt", work.captureId, {
                    id: work.captureId,
                    jobId: job.id,
                    agentId: w.agentId,
                    phase: "capture",
                    number: work.captureAttempts,
                    status: "DONE",
                    snapshotId: s.id,
                  });
                } catch {
                  if (!this.canAdvance(job)) break;
                  this.db.put("round-observation-attempt", work.captureId!, {
                    id: work.captureId,
                    jobId: job.id,
                    agentId: w.agentId,
                    phase: "capture",
                    number: work.captureAttempts,
                    status: "FAILED",
                    reason: "CAPTURE_UNAVAILABLE",
                    finishedAt: this.clock(),
                  });
                  work.nextAt = this.clock() + this.options.retryMs;
                  w.missingReasons = [
                    ...new Set([...w.missingReasons, "CAPTURE_UNAVAILABLE"]),
                  ];
                  this.save(job);
                  continue;
                }
              }
            }
            if (!this.canAdvance(job)) break;
            if (!w.openingSnapshotId) {
              work.done = true;
              this.save(job);
              continue;
            }
            if (work.proofAttempts >= this.options.maxAttempts) {
              work.done = true;
              w.missingReasons.push("PROOF_ATTEMPTS_EXHAUSTED");
              continue;
            }
            work.proofAttempts++;
            const proofAttempt = hash([
              job.id,
              w.agentId,
              "proof",
              work.proofAttempts,
            ]);
            this.save(job);
            this.db.insert("round-observation-attempt", proofAttempt, {
              id: proofAttempt,
              jobId: job.id,
              agentId: w.agentId,
              phase: "proof",
              number: work.proofAttempts,
              status: "RUNNING",
              startedAt: this.clock(),
            });
            try {
              const proof = await adapter.prove(
                w.openingSnapshotId,
                w.closingSnapshotId!,
              );
              if (!this.canAdvance(job)) break;
              w.proofIds.push(proof.proofId);
              w.missingReasons = [
                ...new Set([
                  ...w.missingReasons.filter(
                    (r) =>
                      ![
                        "CAPTURE_UNAVAILABLE",
                        "PROOF_RPC_UNAVAILABLE",
                      ].includes(r),
                  ),
                  ...proof.reasons,
                ]),
              ];
              work.done = true;
              this.db.put("round-observation-attempt", proofAttempt, {
                id: proofAttempt,
                jobId: job.id,
                agentId: w.agentId,
                phase: "proof",
                number: work.proofAttempts,
                status: "DONE",
                proofId: proof.proofId,
              });
            } catch (error) {
              if (!this.canAdvance(job)) break;
              const proofId = (error as { proofId?: string })?.proofId;
              if (proofId && !w.proofIds.includes(proofId))
                w.proofIds.push(proofId);
              this.db.put("round-observation-attempt", proofAttempt, {
                id: proofAttempt,
                jobId: job.id,
                agentId: w.agentId,
                phase: "proof",
                number: work.proofAttempts,
                status: "FAILED",
                reason: "PROOF_RPC_UNAVAILABLE",
                ...(proofId ? { proofId } : {}),
                finishedAt: this.clock(),
              });
              work.nextAt = this.clock() + this.options.retryMs;
              w.missingReasons = [
                ...new Set([...w.missingReasons, "PROOF_RPC_UNAVAILABLE"]),
              ];
            }
            this.save(job);
          }
          if (
            this.canAdvance(job) &&
            (Object.values(job.walletWork).every((w) => w.done) ||
              job.deadlinePinAttempted)
          )
            this.complete(
              job,
              job.deadlinePinAttempted
                ? "UNSETTLED_BOUNDARY_AT_DEADLINE"
                : undefined,
            );
        } finally {
          if (this.owns(job)) {
            job.status = "RETRY";
            delete job.owner;
            delete job.leaseUntil;
            this.db.put("round-observation-job", job.id, job);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
