import { freezeTerminalObservationRoster } from "./round-observation.js";
import {
  createFairElection,
  verifyFairElection,
  type FairElection,
} from "./fair-election.js";
import {
  DEFAULT_ROUND_INTERVAL_MS,
  validInterval,
  terminalTiming,
  validateRoundTiming,
  validateEpochTiming,
  type RoundTiming,
} from "./cadence.js";
import { Store } from "./store.js";
import { Confirmations, type ConfirmationCertificate } from "./confirmation.js";
import { leader, hash, type Candidate } from "./protocol.js";
export interface EpochConfig {
  termSlots: number;
  committeeSize: number;
  timeoutMs: number;
  epochMs?: number;
}
// Cadence is frozen per round separately; an interval-only upgrade must not recompute an active term.
export function sameResearchNetworkConfig(a: EpochConfig, b: EpochConfig) {
  const { epochMs: _a, ...left } = a,
    { epochMs: _b, ...right } = b;
  return hash(left) === hash(right);
}
export interface Epoch {
  id: string;
  slot: number;
  term: number;
  view: number;
  master: string;
  committee: Candidate[];
  snapshotHash: string;
  electionHash?: string;
  configHash: string;
  config: EpochConfig;
  deadline: number;
  status: "RUNNING" | "PUBLISHED" | "FAILED";
  output?: unknown;
  signature?: string;
  rotationSlot?: number;
  roundIntervalMs?: number;
  timingVersion?: "fixed-start/1";
  scheduledAt?: number;
  startedAt?: number;
  roundDeadline?: number;
  researchDeadline?: number;
  roundTiming?: RoundTiming;
  finishedAt?: number;
  nextEligibleAt?: number;
  confirmationRequired?: boolean;
  confirmationDeadline?: number;
  confirmationViewMs?: number;
  confirmation?: ConfirmationCertificate;
}
export class Epochs {
  constructor(readonly db: Store) {}
  get(id: string) {
    const e = this.db.get<Epoch>("epoch", id);
    if (!e) throw Error("epoch not found");
    validateEpochTiming(e);
    return e;
  }
  open(
    slot: number,
    candidates: Candidate[],
    config: EpochConfig,
    now = Date.now(),
    timing?: RoundTiming,
    scheduledAt = now,
  ): Epoch {
    return this.db.transaction(() => {
      if (
        !Number.isSafeInteger(slot) ||
        slot < 0 ||
        !Number.isInteger(config.termSlots) ||
        config.termSlots < 1 ||
        config.timeoutMs < 1
      )
        throw Error("invalid epoch config");
      if (timing) {
        validateRoundTiming(timing);
        if (
          !Number.isSafeInteger(scheduledAt) ||
          scheduledAt < 0 ||
          now < scheduledAt ||
          !Number.isSafeInteger(scheduledAt + timing.maxDurationMs) ||
          now >=
            scheduledAt + timing.maxDurationMs - timing.confirmationReserveMs
        )
          throw Error("round admission expired");
      }
      const id = String(slot),
        existing = this.db.get<Epoch>("epoch", id);
      if (existing) return existing;
      if (this.db.all<Epoch>("epoch").some((e) => e.status === "RUNNING"))
        throw Error("epoch already running");
      const term = Math.floor(slot / config.termSlots),
        termId = String(term),
        configHash = hash(config);
      let saved = this.db.get<{
        committee: Candidate[];
        snapshotHash: string;
        configHash: string;
        config?: EpochConfig;
        electionHash?: string;
      }>("term", termId);
      if (!saved) {
        const { proof, committee } = createFairElection(
          this.db,
          term,
          candidates,
          config.committeeSize,
          configHash,
        );
        saved = {
          committee,
          electionHash: hash(proof),
          snapshotHash: hash(
            [...candidates].sort((a, b) => a.id.localeCompare(b.id)),
          ),
          configHash,
          config,
        };
        this.db.insert("election", termId, proof);
        this.db.insert("term", termId, saved);
      }
      if (saved.electionHash) {
        const proof = this.db.get<FairElection>("election", termId);
        if (
          !proof ||
          proof.term !== term ||
          !verifyFairElection(
            proof,
            saved.electionHash,
            saved.committee,
            saved.configHash,
          )
        )
          throw Error("invalid saved election proof");
      }
      let frozenConfig = config;
      if (saved.configHash !== configHash) {
        const priorConfig =
          saved.config ??
          this.db.all<Epoch>("epoch").find((e) => e.term === term)?.config;
        if (
          !priorConfig ||
          hash(priorConfig) !== saved.configHash ||
          !sameResearchNetworkConfig(priorConfig, config)
        )
          throw Error("configuration changes require a new term");
        frozenConfig = priorConfig;
      }
      // Current availability is checked by the runner; frozen committee never shrinks.
      const e: Epoch = {
        id,
        slot,
        term,
        view: 0,
        master: leader(
          saved.committee,
          saved.electionHash ? slot : slot % config.termSlots,
          0,
        ).id,
        ...(saved.electionHash ? { rotationSlot: slot } : {}),
        ...saved,
        config: frozenConfig,
        roundIntervalMs: validInterval(
          config.epochMs ?? DEFAULT_ROUND_INTERVAL_MS,
        ),
        deadline: now + config.timeoutMs,
        ...(timing
          ? {
              timingVersion: timing.version,
              roundTiming: { ...timing },
              scheduledAt,
              startedAt: now,
              roundIntervalMs: timing.intervalMs,
              roundDeadline: scheduledAt + timing.maxDurationMs,
              researchDeadline:
                scheduledAt +
                timing.maxDurationMs -
                timing.confirmationReserveMs,
              deadline: Math.min(
                scheduledAt +
                  timing.maxDurationMs -
                  timing.confirmationReserveMs,
                now + timing.viewTimeoutMs,
              ),
            }
          : {}),
        status: "RUNNING",
        confirmationRequired: true,
      };
      this.db.insert("epoch", id, e);
      return e;
    });
  }
  fail(id: string, expectedView: number, reason: string, now = Date.now()) {
    return this.db.transaction(() => {
      const e = this.get(id);
      if (e.status !== "RUNNING" || e.view !== expectedView)
        throw Error("stale epoch");
      this.incident(`${id}:${expectedView}:terminal`, e.master, reason, now);
      const failed: Epoch = {
        ...e,
        status: "FAILED",
        ...terminalTiming(e, now),
      };
      this.db.put("epoch", id, failed);
      freezeTerminalObservationRoster(this.db, failed);
      return failed;
    });
  }
  failedView(id: string, view: number) {
    return (
      this.db
        .all<{
          epoch?: string;
          view?: number;
          status: string;
          terminalReason?: string;
        }>("research-task")
        .some(
          (t) => t.epoch === id && t.view === view && t.status === "FAILED",
        ) || !!this.db.get("research-failure", `${id}:${view}`)
    );
  }
  recoverFailedView(id: string, expectedView: number, now = Date.now()) {
    return this.advance(id, expectedView, now, true);
  }
  takeover(id: string, expectedView: number, now = Date.now()) {
    return this.advance(id, expectedView, now, false);
  }
  private advance(
    id: string,
    expectedView: number,
    now: number,
    failed: boolean,
  ) {
    return this.db.transaction(() => {
      const e = this.get(id);
      if (e.status !== "RUNNING" || e.view !== expectedView)
        throw Error("stale epoch");
      if (failed) {
        if (
          this.db.get("confirmation-proposal", id) ||
          !this.failedView(id, expectedView)
        )
          throw Error("required task failure proof missing");
      } else if (now < e.deadline) throw Error("deadline not reached");
      if (
        (e.roundDeadline !== undefined && now >= e.roundDeadline) ||
        (!e.confirmationDeadline &&
          e.researchDeadline !== undefined &&
          now >= e.researchDeadline) ||
        (e.confirmationDeadline !== undefined &&
          now >= e.confirmationDeadline) ||
        e.view + 1 >= e.committee.length
      ) {
        e.status = "FAILED";
        Object.assign(e, terminalTiming(e, now));
      } else {
        e.view++;
        e.master = leader(
          e.committee,
          e.rotationSlot ?? e.slot % e.config.termSlots,
          e.view,
        ).id;
        e.deadline = Math.min(
          e.roundDeadline ?? Number.MAX_SAFE_INTEGER,
          e.confirmationDeadline ??
            e.researchDeadline ??
            Number.MAX_SAFE_INTEGER,
          now +
            (e.confirmationViewMs ??
              e.roundTiming?.viewTimeoutMs ??
              e.config.timeoutMs),
        );
      }
      this.db.put("epoch", id, e);
      freezeTerminalObservationRoster(this.db, e);
      return e;
    });
  }
  publish(
    id: string,
    view: number,
    master: string,
    output: unknown,
    signature: string,
    now = Date.now(),
  ) {
    return this.db.transaction(() => {
      const e = this.get(id);
      if (
        now >= e.deadline ||
        (e.roundDeadline !== undefined && now >= e.roundDeadline)
      )
        throw Error("epoch deadline expired");
      if (e.status === "PUBLISHED") throw Error("already published");
      if (e.status !== "RUNNING" || e.view !== view || e.master !== master)
        throw Error("stale epoch");
      let confirmation: ConfirmationCertificate | undefined;
      if (e.confirmationRequired) {
        const book = new Confirmations(this.db);
        const proposal = book.proposal(id);
        if (
          !proposal ||
          proposal.descriptor.proposalHash !== hash({ output, signature })
        )
          throw Error("publication differs from frozen candidate");
        confirmation = book.certificate(e, now);
      }
      this.db.put("epoch", id, {
        ...e,
        ...(confirmation ? { confirmation } : {}),
        status: "PUBLISHED",
        ...terminalTiming(e, now),
        output,
        signature,
      });
      freezeTerminalObservationRoster(this.db, this.get(id));
    });
  }
  incident(id: string, agent: string, reason: string, at = Date.now()) {
    return this.db.transaction(() => {
      const old = this.db.get<any>("incident", id);
      if (old) return old;
      const entry = { id, agent, reason, at, financialPenalty: "0" };
      this.db.insert("incident", id, entry);
      return entry;
    });
  }
}
