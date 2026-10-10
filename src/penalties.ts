import { Agents } from "./agents.js";
import { Epochs } from "./epochs.js";
import { hash, leader } from "./protocol.js";
import { qspSchema, verifyQsp } from "./qsp.js";
export class Penalties {
  constructor(
    readonly agents: Agents,
    readonly epochs: Epochs,
    readonly chainId: number,
    readonly failureLimit: number,
    readonly jailMs: number,
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
        agent,
        reason: "CONFLICTING_SIGNATURE",
        until: null,
        financialPenalty: "0",
      });
  }
  failure(
    id: string,
    agent: string,
    now = Date.now(),
    reason = "PLATFORM_TIMEOUT",
  ) {
    this.epochs.incident(id, agent, reason, now);
    if (this.hasSecurityEvidence(agent)) {
      this.agents.db.transaction(() => this.holdSecurityIsolation(agent));
      return;
    }
    const releasedAt =
      this.agents.db.get<{ releasedAt?: number }>("quarantine", agent)
        ?.releasedAt ?? 0;
    const recent = this.agents.db
      .all<any>("incident")
      .filter(
        (x) =>
          x.agent === agent &&
          ["PLATFORM_TIMEOUT", "INVALID_OUTPUT"].includes(x.reason) &&
          x.at > Math.max(now - 86400000, releasedAt),
      );
    if (recent.length >= this.failureLimit) {
      const quarantine = this.agents.db.get<{ reason: string }>(
        "quarantine",
        agent,
      );
      if (
        quarantine?.reason &&
        quarantine.reason !== "REPEATED_PLATFORM_FAILURE"
      )
        return;
      this.agents.update(agent, { jailed: true });
      this.agents.db.put("quarantine", agent, {
        agent,
        reason: "REPEATED_PLATFORM_FAILURE",
        until: now + this.jailMs,
        financialPenalty: "0",
      });
    }
  }
  observeResearch(now = Date.now()) {
    // Immutable, previously verified evidence survives old admin releases and restarts.
    this.agents.db.transaction(() => {
      for (const agent of new Set(
        this.agents.db.all<{ agent: string }>("evidence").map((e) => e.agent),
      ))
        this.holdSecurityIsolation(agent);
    });
    for (const attempt of this.agents.db.all<{
      id: string;
      agent: string;
      status: string;
      failure?: string;
    }>("research-attempt")) {
      if (attempt.status !== "FAILED" || attempt.failure !== "INVALID_OUTPUT")
        continue;
      const id = `research:${attempt.id}`;
      if (!this.agents.db.get("incident", id))
        this.failure(id, attempt.agent, now, "INVALID_OUTPUT");
    }
  }
  async recoverOperational(
    healthy: (agent: string) => Promise<boolean>,
    now = Date.now(),
  ) {
    for (const record of this.agents.db.all<{
      agent: string;
      reason: string;
      until: number | null;
    }>("quarantine")) {
      if (
        record.reason !== "REPEATED_PLATFORM_FAILURE" ||
        record.until === null ||
        now < record.until ||
        this.hasSecurityEvidence(record.agent)
      )
        continue;
      try {
        if (!(await healthy(record.agent))) continue;
        this.agents.db.transaction(() => {
          const live = this.agents.db.get<typeof record>(
            "quarantine",
            record.agent,
          );
          if (
            live?.reason !== record.reason ||
            live.until !== record.until ||
            this.hasSecurityEvidence(record.agent)
          )
            return;
          this.agents.update(record.agent, { jailed: false });
          this.agents.db.put("quarantine", record.agent, {
            agent: record.agent,
            releasedAt: now,
            automatic: true,
            financialPenalty: "0",
          });
        });
      } catch {
        /* Failed health proofs are probed on the next maintenance pass. */
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
