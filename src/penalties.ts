import { Agents } from "./agents.js";
import { Epochs } from "./epochs.js";
import { hash } from "./protocol.js";
import { qspSchema, verifyQsp } from "./qsp.js";
export class Penalties {
  constructor(
    readonly agents: Agents,
    readonly epochs: Epochs,
    readonly chainId: number,
    readonly failureLimit: number,
    readonly jailMs: number,
  ) {}
  failure(
    id: string,
    agent: string,
    now = Date.now(),
    reason = "PLATFORM_TIMEOUT",
  ) {
    this.epochs.incident(id, agent, reason, now);
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
        now < record.until
      )
        continue;
      try {
        if (!(await healthy(record.agent))) continue;
        this.agents.db.transaction(() => {
          const live = this.agents.db.get<typeof record>(
            "quarantine",
            record.agent,
          );
          if (live?.reason !== record.reason || live.until !== record.until)
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
    if (!epoch.committee.some((c) => c.id === a.master))
      throw Error("signer outside committee");
    if (
      !verifyQsp(this.chainId, a, signature1, agent.wallet) ||
      !verifyQsp(this.chainId, b, signature2, agent.wallet)
    )
      throw Error("invalid evidence signature");
    const id = hash([a.master, ...[hash(a), hash(b)].sort()]);
    return this.agents.db.transaction(() => {
      const old = this.agents.db.get("evidence", id);
      if (old) return old;
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
    const a = this.agents.get(agent);
    this.agents.update(a.id, { jailed: false });
    this.agents.db.put("quarantine", a.id, {
      agent,
      releasedAt: Date.now(),
      financialPenalty: "0",
    });
  }
}
