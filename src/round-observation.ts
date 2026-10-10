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
export function readObservationSnapshot(
  db: Store,
  id: string,
): PortfolioSnapshot {
  const s = db.get<PortfolioSnapshot>("portfolio-snapshot", id);
  if (!s) throw Error("OBSERVATION_SNAPSHOT_MISSING");
  const { id: actual, ...body } = s;
  const capture = db.get<any>("portfolio-capture", s.requestId);
  if (
    actual !== id ||
    hash(body) !== id ||
    capture?.status !== "DONE" ||
    capture.snapshotId !== id ||
    hash(capture.registry) !== s.registryHash
  )
    throw Error("OBSERVATION_SNAPSHOT_INTEGRITY");
  return s;
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
      const proof = db.get<any>("round-cashflow-proof", id);
      if (!proof) throw Error("OBSERVATION_PROOF_MISSING");
      const { id: actual, ...body } = proof;
      if (
        actual !== id ||
        hash(body) !== id ||
        proof.openingSnapshotId !== w.openingSnapshotId ||
        proof.closingSnapshotId !== w.closingSnapshotId
      )
        throw Error("OBSERVATION_PROOF_INTEGRITY");
      if (proof.status === "KNOWN") known = true;
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
