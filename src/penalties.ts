import { Agents } from "./agents.js";
import { Epochs } from "./epochs.js";
import { hash, leader } from "./protocol.js";
import {
  history,
  reconcileResearchTasks,
  researchStrikes,
  type Strike,
} from "./research-task-state.js";
import { qspSchema, verifyQsp } from "./qsp.js";
export class Penalties {
  constructor(
    readonly agents: Agents,
    readonly epochs: Epochs,
    readonly chainId: number,
    readonly failureLimit: number,
    readonly jailMs: number,
    readonly clock: () => number = Date.now,
  ) {}
  private hasSecurityEvidence(agent: string) {
    return this.agents.db
      .all<{ agent: string }>("evidence")
      .some((e) => e.agent === agent);
  }
  private holdSecurityIsolation(agent: string) {
    const current = this.agents.get(agent),
      record = this.agents.db.get<{ reason?: string }>("quarantine", agent);
    if (!current.jailed) this.agents.update(agent, { jailed: true });
    if (record?.reason !== "CONFLICTING_SIGNATURE")
      this.agents.db.put("quarantine", agent, {
        ...this.agents.db.get<any>("quarantine", agent),
        agent,
        reason: "CONFLICTING_SIGNATURE",
        until: null,
        financialPenalty: "0",
      });
  }
  private watermark(agent: string) {
    const db = this.agents.db;
    const current = db.get<any>("quarantine", agent);
    const releasedAt = Math.max(
      current?.releasedAt ?? 0,
      ...history(db, "quarantine", agent).map((r) =>
        Number.isFinite(r.data.releasedAt) ? r.data.releasedAt : 0,
      ),
    );
    if (current && releasedAt > (current.releasedAt ?? 0))
      db.put("quarantine", agent, { ...current, releasedAt });
    return releasedAt;
  }
  private projection(agent: string, now: number) {
    const db = this.agents.db,
      releasedAt = this.watermark(agent);
    const all: Strike[] = [
      ...researchStrikes(db, now),
      ...db
        .all<any>("incident")
        .filter((x) => x.actionableSource === "STANDALONE_FAILURE")
        .map((x) => ({
          id: `standalone:${x.id}`,
          agent: x.agent,
          eventAt: x.at,
          offendingAttemptIds: [],
          provenance: "explicit",
        })),
    ];
    const events = all
      .filter(
        (e) =>
          e.agent === agent &&
          (e.eventAt === undefined ||
            e.eventAt > Math.max(releasedAt, now - 86400000)),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      policyVersion: 1,
      releasedAt,
      count: events.filter((e) => e.eventAt !== undefined).length,
      unresolved: events.filter((e) => e.eventAt === undefined).length,
      digest: hash(JSON.parse(JSON.stringify(events))),
      events,
    };
  }
  private apply(agent: string, now: number) {
    const db = this.agents.db;
    if (this.hasSecurityEvidence(agent)) {
      this.holdSecurityIsolation(agent);
      return;
    }
    const projection = this.projection(agent, now),
      current = db.get<any>("quarantine", agent);
    if (current?.reason && current.reason !== "REPEATED_PLATFORM_FAILURE")
      return;
    const basis = {
      policyVersion: 1,
      projectionDigest: projection.digest,
      effectiveCount: projection.count,
      unresolvedCount: projection.unresolved,
      reconciliationBasis: projection.events,
    };
    if (
      current?.reason === "REPEATED_PLATFORM_FAILURE" &&
      current.projectionDigest !== projection.digest
    )
      db.put("quarantine", agent, { ...current, ...basis });
    if (projection.count < this.failureLimit) return;
    const ids = projection.events
      .filter((e) => e.eventAt !== undefined)
      .map((e) => e.id);
    const applied: string[] = current?.appliedEventIds ?? [];
    if (
      current?.reason === "REPEATED_PLATFORM_FAILURE" &&
      ids.every((id) => applied.includes(id))
    )
      return;
    this.agents.update(agent, { jailed: true });
    db.put("quarantine", agent, {
      ...current,
      agent,
      reason: "REPEATED_PLATFORM_FAILURE",
      until: now + this.jailMs,
      financialPenalty: "0",
      releasedAt: projection.releasedAt,
      ...basis,
      appliedAt: now,
      appliedEventIds: [...new Set([...applied, ...ids])].sort(),
    });
  }
  failure(
    id: string,
    agent: string,
    now = Date.now(),
    reason = "PLATFORM_TIMEOUT",
  ) {
    this.agents.db.transaction(() => {
      this.epochs.incident(id, agent, reason, now);
      const incident = this.agents.db.get<any>("incident", id);
      // Only this explicit API opts independent failures into accounting.
      // Runner aggregate incidents and raw research diagnostics never do.
      if (
        incident &&
        incident.agent === agent &&
        ["INVALID_OUTPUT", "PLATFORM_TIMEOUT"].includes(reason) &&
        !incident.actionableSource
      )
        this.agents.db.put("incident", id, {
          ...incident,
          actionableSource: "STANDALONE_FAILURE",
        });
      this.apply(agent, now);
    });
  }
  observeResearch(now = Date.now()) {
    const db = this.agents.db;
    db.transaction(() => {
      for (const agent of new Set(
        db.all<{ agent: string }>("evidence").map((e) => e.agent),
      ))
        this.holdSecurityIsolation(agent);
      reconcileResearchTasks(db, now);
      // Resolve provenance BEFORE inserting diagnostics: observation time must
      // never manufacture a timestamp for unresolved legacy evidence.
      const projected = researchStrikes(db, now);
      for (const attempt of db.all<any>("research-attempt")) {
        if (attempt.status !== "FAILED" || attempt.failure !== "INVALID_OUTPUT")
          continue;
        const id = `research:${attempt.id}`;
        if (!db.get("incident", id)) {
          this.epochs.incident(
            id,
            attempt.agent,
            "INVALID_OUTPUT",
            attempt.finishedAt ?? now,
          );
          db.put("incident", id, {
            ...db.get<any>("incident", id),
            diagnostic: true,
            timestampUnresolved: !Number.isFinite(attempt.finishedAt),
          });
        }
      }
      for (const agent of new Set([
        ...projected.map((e) => e.agent),
        ...db.all<{ agent: string }>("quarantine").map((q) => q.agent),
      ]))
        this.apply(agent, now);
    });
  }
  async recoverOperational(
    healthy: (agent: string) => Promise<boolean>,
    now = this.clock(),
  ) {
    this.observeResearch(now);
    const db = this.agents.db;
    for (const record of db.all<any>("quarantine")) {
      if (
        record.reason !== "REPEATED_PLATFORM_FAILURE" ||
        record.until === null ||
        this.hasSecurityEvidence(record.agent) ||
        !this.agents.get(record.agent).jailed
      )
        continue;
      const before = this.projection(record.agent, now);
      const early = now < record.until;
      if (early && before.count + before.unresolved >= this.failureLimit)
        continue;
      const identity = hash(db.get("quarantine", record.agent));
      try {
        if (!(await healthy(record.agent))) continue;
        db.transaction(() => {
          const committedAt = this.clock();
          reconcileResearchTasks(db, committedAt);
          const after = this.projection(record.agent, committedAt);
          const live = db.get<any>("quarantine", record.agent);
          if (this.hasSecurityEvidence(record.agent)) {
            this.holdSecurityIsolation(record.agent);
            return;
          }
          if (
            hash(live) !== identity ||
            !this.agents.get(record.agent).jailed ||
            after.digest !== before.digest ||
            after.releasedAt !== before.releasedAt ||
            (early && after.count + after.unresolved >= this.failureLimit)
          )
            return;
          this.agents.update(record.agent, { jailed: false });
          db.put("quarantine", record.agent, {
            ...live,
            reason: undefined,
            until: undefined,
            releasedAt: early ? after.releasedAt : committedAt,
            automatic: true,
            releaseReason: early ? "TASK_PENALTY_RECONCILIATION" : "COOLDOWN",
            reconciledAt: committedAt,
            policyVersion: 1,
            projectionDigest: after.digest,
            effectiveCount: after.count,
            financialPenalty: "0",
          });
        });
      } catch {
        /* Retry the full health proof on the next maintenance pass. */
      }
    }
  }
  evidence(
    first: unknown,
    signature1: string,
    second: unknown,
    signature2: string,
  ) {
    const a = qspSchema.parse(first),
      b = qspSchema.parse(second);
    if (
      a.epoch !== b.epoch ||
      a.view !== b.view ||
      a.master !== b.master ||
      hash(a) === hash(b)
    )
      throw Error("not conflicting final commitments");
    const agent = this.agents.get(a.master),
      epoch = this.epochs.get(a.epoch);
    const signer = epoch.committee.find((c) => c.id === a.master);
    if (
      !signer ||
      a.committeeHash !== hash(epoch.committee) ||
      b.committeeHash !== hash(epoch.committee)
    )
      throw Error("evidence does not bind the frozen committee");
    if (
      a.view > epoch.view ||
      a.view >= epoch.committee.length ||
      leader(
        epoch.committee,
        epoch.rotationSlot ?? epoch.slot % epoch.config.termSlots,
        a.view,
      ).id !== a.master
    )
      throw Error("evidence signer is not the elected Master for this view");
    if (hash(a) !== hash(first) || hash(b) !== hash(second))
      throw Error("evidence payload normalization mismatch");
    if (
      !verifyQsp(this.chainId, a, signature1, signer.wallet) ||
      !verifyQsp(this.chainId, b, signature2, signer.wallet)
    )
      throw Error("invalid evidence signature");
    const id = hash([a.master, ...[hash(a), hash(b)].sort()]);
    return this.agents.db.transaction(() => {
      const old = this.agents.db.get("evidence", id);
      if (old) {
        this.holdSecurityIsolation(agent.id);
        return old;
      }
      const record = {
        id,
        agent: agent.id,
        first: a,
        signature1,
        second: b,
        signature2,
        financialPenalty: "0",
        responsibility: "PLATFORM_CUSTODY_REVIEW_REQUIRED",
      };
      this.agents.db.insert("evidence", id, record);
      this.agents.update(agent.id, { jailed: true });
      this.agents.db.put("quarantine", agent.id, {
        ...this.agents.db.get<any>("quarantine", agent.id),
        agent: agent.id,
        reason: "CONFLICTING_SIGNATURE",
        until: null,
        financialPenalty: "0",
      });
      return record;
    });
  }
  release(agent: string) {
    return this.agents.db.transaction(() => {
      const a = this.agents.get(agent),
        record = this.agents.db.get<{ reason?: string }>("quarantine", agent);
      if (
        this.hasSecurityEvidence(agent) ||
        (record?.reason && record.reason !== "REPEATED_PLATFORM_FAILURE")
      )
        throw Error("security quarantine cannot be manually released");
      if (!a.jailed) return;
      if (record?.reason !== "REPEATED_PLATFORM_FAILURE")
        throw Error("only operational quarantine can be released");
      this.agents.update(a.id, { jailed: false });
      this.agents.db.put("quarantine", a.id, {
        agent,
        releasedAt: Date.now(),
        financialPenalty: "0",
      });
    });
  }
}
