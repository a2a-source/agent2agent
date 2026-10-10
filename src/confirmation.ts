import { verifyMessage } from "ethers";
import { hash, type Candidate } from "./protocol.js";
import { qspSchema, synthesisSchema, verifyQsp } from "./qsp.js";
import { Store } from "./store.js";
import type { Epoch } from "./epochs.js";
import {
  validateNewsBodyClaims,
  validateRoleCoverage,
} from "./research-guidance.js";
import type { Observation } from "./agent-runtime.js";

export interface ConfirmationDescriptor {
  version: "a2a-confirmation/1";
  chainId: number;
  epoch: string;
  proposalHash: string;
  committeeHash: string;
  configHash: string;
  expiresAt: number;
}
export interface ConfirmationCertificate extends ConfirmationDescriptor {
  votes: { agent: string; signature: string }[];
  confirmedAt: number;
}
interface Options {
  chainId: number;
  timeoutMs: number;
  roles: string[];
  expectedConfigHash: string;
  toolsEnabled: boolean;
  templatesHash?: string;
  recordVersion?: string;
}
export interface ConfirmationProposal {
  descriptor: ConfirmationDescriptor;
  output: unknown;
  signature: string;
  options: Options;
}
export class ConfirmationPending extends Error {}
export function confirmationQuorum(size: number) {
  if (!Number.isSafeInteger(size) || size < 3 || size > 45)
    throw Error("invalid committee size");
  return Math.floor((2 * size) / 3) + 1;
}
export function confirmationMessage(d: ConfirmationDescriptor) {
  return `A2A-QSP-CONFIRM:1:${hash(d)}`;
}
function signed(message: string, signature: string, wallet: string) {
  try {
    return (
      verifyMessage(message, signature).toLowerCase() === wallet.toLowerCase()
    );
  } catch {
    return false;
  }
}
/** The committee and network hash must come from a trusted epoch snapshot. */
export function verifyConfirmation(
  chainId: number,
  output: unknown,
  signature: string,
  certificate: ConfirmationCertificate,
  committee: Candidate[],
  configHash: string,
): boolean {
  try {
    const { votes, confirmedAt, ...d } = certificate;
    const q = qspSchema.parse(output);
    if (
      hash(q) !== hash(output) ||
      d.version !== "a2a-confirmation/1" ||
      d.chainId !== chainId ||
      d.epoch !== q.epoch ||
      d.proposalHash !== hash({ output, signature }) ||
      d.committeeHash !== hash(committee) ||
      q.committeeHash !== d.committeeHash ||
      d.configHash !== configHash ||
      !Number.isSafeInteger(d.expiresAt) ||
      !Number.isSafeInteger(confirmedAt) ||
      confirmedAt < 0 ||
      confirmedAt >= d.expiresAt ||
      (q.version === "a2a-qsp/2" &&
        (confirmedAt < q.createdAt || d.expiresAt > q.validUntil)) ||
      new Set(committee.map((c) => c.id)).size !== committee.length ||
      new Set(committee.map((c) => c.wallet.toLowerCase())).size !==
        committee.length ||
      votes.length < confirmationQuorum(committee.length) ||
      votes.length > committee.length ||
      new Set(votes.map((v) => v.agent)).size !== votes.length
    )
      return false;
    const proposer = committee.find((c) => c.id === q.master);
    if (!proposer || !verifyQsp(chainId, output, signature, proposer.wallet))
      return false;
    return votes.every((v) => {
      const member = committee.find((c) => c.id === v.agent);
      return (
        !!member && signed(confirmationMessage(d), v.signature, member.wallet)
      );
    });
  } catch {
    return false;
  }
}
/** Verifies a stored epoch using its original proposer, including the mandatory new certificate. */
export function verifyPublishedEpoch(chainId: number, epoch: Epoch): boolean {
  try {
    if (epoch.status !== "PUBLISHED" || !epoch.signature) return false;
    const q = qspSchema.parse(epoch.output),
      signer = epoch.committee.find((c) => c.id === q.master);
    if (
      q.epoch !== epoch.id ||
      q.committeeHash !== hash(epoch.committee) ||
      !signer
    )
      return false;
    return epoch.confirmationRequired
      ? !!epoch.confirmation &&
          verifyConfirmation(
            chainId,
            epoch.output,
            epoch.signature,
            epoch.confirmation,
            epoch.committee,
            epoch.configHash,
          )
      : verifyQsp(chainId, epoch.output, epoch.signature, signer.wallet);
  } catch {
    return false;
  }
}
export class Confirmations {
  constructor(readonly db: Store) {}
  proposal(id: string) {
    return this.db.get<ConfirmationProposal>("confirmation-proposal", id);
  }
  private live(epoch: Epoch, now: number) {
    const live = this.db.get<Epoch>("epoch", epoch.id);
    if (
      !live ||
      live.status !== "RUNNING" ||
      live.view !== epoch.view ||
      live.master !== epoch.master
    )
      throw Error("stale confirmation coordinator");
    if (
      now >= live.deadline ||
      (live.confirmationDeadline !== undefined &&
        now >= live.confirmationDeadline)
    )
      throw Error("confirmation deadline expired");
    return live;
  }
  private validate(p: ConfirmationProposal, epoch: Epoch) {
    const { descriptor: d, output, signature, options: o } = p;
    if (d.proposalHash !== hash({ output, signature }))
      throw Error("proposal hash changed");
    const q = qspSchema.parse(output);
    if (
      hash(q) !== hash(output) ||
      q.epoch !== epoch.id ||
      q.committeeHash !== hash(epoch.committee) ||
      q.configHash !== o.expectedConfigHash ||
      d.configHash !== epoch.configHash ||
      d.committeeHash !== q.committeeHash ||
      d.chainId !== o.chainId ||
      d.epoch !== epoch.id ||
      d.version !== "a2a-confirmation/1"
    )
      throw Error("proposal binding changed");
    const proposer = epoch.committee.find((c) => c.id === q.master);
    if (!proposer || !verifyQsp(o.chainId, output, signature, proposer.wallet))
      throw Error("invalid proposal signature");
    if (
      q.reports.length !== o.roles.length ||
      new Set(q.reports.map((r) => r.role)).size !== o.roles.length ||
      q.reports.some(
        (r) =>
          !o.roles.includes(r.role) ||
          r.agent === q.master ||
          !epoch.committee.some((c) => c.id === r.agent),
      )
    )
      throw Error("invalid report roles or agents");
    if (o.recordVersion) {
      if (
        this.db.get<{ version: string }>("run-config", epoch.id)?.version !==
          o.recordVersion ||
        o.expectedConfigHash !==
          hash({ network: epoch.configHash, research: o.recordVersion })
      )
        throw Error("run configuration changed");
      for (const report of q.reports) {
        const key = `${epoch.id}:report:${report.role}`,
          row = this.db.get<any>("report", key);
        if (
          !row ||
          row.version !== o.recordVersion ||
          hash(row.report) !== hash(report)
        )
          throw Error("stored report changed");
        if (q.version === "a2a-qsp/1") {
          const source = this.db.get<any>("source", key);
          if (!source || row.sourceHash !== hash(source))
            throw Error("stored source changed");
        }
      }
    }
    if (q.version === "a2a-qsp/1") {
      synthesisSchema.parse({ signals: q.signals, risks: q.risks });
      if (
        q.signals.some(
          (s) =>
            s.chainId !== o.chainId ||
            s.evidence.some(
              (id) =>
                !q.reports.some((r) => r.role === id && r.sources.length > 0),
            ),
        )
      )
        throw Error("signal lacks verified evidence");
    } else {
      const previous = q.context.previous;
      if (previous) {
        const prior = this.db.get<Epoch>("epoch", previous.epoch);
        if (
          !prior ||
          prior.slot >= epoch.slot ||
          hash(prior.output) !== previous.hash ||
          !verifyPublishedEpoch(o.chainId, prior)
        )
          throw Error("previous QSP confirmation or hash changed");
      }
      const context = this.db.get<any>("research-context", epoch.id);
      if (
        !context ||
        context.hash !== q.contextHash ||
        hash(context.context) !== q.contextHash
      )
        throw Error("frozen research context changed");
      if (
        !q.researchChecks ||
        !q.reportTemplates ||
        !o.templatesHash ||
        hash(q.reportTemplates) !== o.templatesHash ||
        !q.policyTextVersion
      )
        throw Error("required research policies missing");
      for (const e of [
        ...q.context.evidence,
        ...q.reports.flatMap((r) => r.additionalEvidence),
      ]) {
        const stored = this.db.get<any>("research-evidence", e.id);
        if (!stored || hash(stored.data) !== e.contentHash)
          throw Error("research evidence hash changed");
      }
      for (const r of q.reports) {
        const observations = r.additionalEvidence
          .filter((e) => e.url.startsWith("tool://"))
          .map(
            (e) =>
              this.db.get<any>("research-evidence", e.id)!.data as Observation,
          );
        validateNewsBodyClaims(r.role, r, observations);
        if (o.toolsEnabled)
          validateRoleCoverage(r.role, q.context, observations);
      }
    }
    return q;
  }
  freeze(
    epoch: Epoch,
    output: unknown,
    signature: string,
    options: Options,
    now = Date.now(),
  ) {
    return this.db.transaction(() => {
      const live = this.live(epoch, now),
        prior = this.proposal(epoch.id);
      if (prior) {
        if (prior.descriptor.proposalHash !== hash({ output, signature }))
          throw Error("candidate already frozen");
        this.validate(prior, live);
        return prior;
      }
      const q = qspSchema.parse(output);
      if (q.master !== live.master || q.view !== live.view)
        throw Error("stale proposal");
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
        throw Error("invalid confirmation timeout");
      const expiresAt = Math.min(
        now + options.timeoutMs,
        q.version === "a2a-qsp/2" ? q.validUntil : Number.MAX_SAFE_INTEGER,
      );
      if (expiresAt <= now) throw Error("proposal expired");
      const p: ConfirmationProposal = {
        output,
        signature,
        options,
        descriptor: {
          version: "a2a-confirmation/1",
          chainId: options.chainId,
          epoch: epoch.id,
          proposalHash: hash({ output, signature }),
          committeeHash: hash(live.committee),
          configHash: live.configHash,
          expiresAt,
        },
      };
      this.validate(p, live);
      this.db.insert("confirmation-proposal", epoch.id, p);
      const viewMs = Math.max(
        1,
        Math.floor((expiresAt - now) / live.committee.length),
      );
      this.db.put("epoch", epoch.id, {
        ...live,
        confirmationDeadline: expiresAt,
        confirmationViewMs: viewMs,
        deadline: Math.min(expiresAt, now + viewMs),
      });
      return p;
    });
  }
  private checked(epoch: Epoch, now: number) {
    const live = this.live(epoch, now),
      p = this.proposal(epoch.id);
    if (!p) throw Error("confirmation proposal missing");
    if (now >= p.descriptor.expiresAt) throw Error("confirmation expired");
    this.validate(p, live);
    return { live, p };
  }
  intent(epoch: Epoch, agent: string, now = Date.now()) {
    return this.db.transaction(() => {
      const { live, p } = this.checked(epoch, now);
      if (!live.committee.some((c) => c.id === agent))
        throw Error("not in committee");
      const id = `${epoch.id}:${agent}`,
        message = confirmationMessage(p.descriptor);
      const prior = this.db.get<{ message: string }>("confirmation-intent", id);
      if (prior && prior.message !== message)
        throw Error("conflicting confirmation intent");
      if (!prior) this.db.insert("confirmation-intent", id, { message });
      return message;
    });
  }
  vote(epoch: Epoch, agent: string, signature: string, now = Date.now()) {
    return this.db.transaction(() => {
      const { live, p } = this.checked(epoch, now),
        member = live.committee.find((c) => c.id === agent);
      const id = `${epoch.id}:${agent}`,
        message = confirmationMessage(p.descriptor);
      if (
        !member ||
        this.db.get<{ message: string }>("confirmation-intent", id)?.message !==
          message ||
        !signed(message, signature, member.wallet)
      )
        throw Error("invalid confirmation signature or intent");
      const prior = this.db.get<{ signature: string }>("confirmation-vote", id);
      if (prior && prior.signature !== signature)
        throw Error("conflicting vote");
      if (!prior) this.db.insert("confirmation-vote", id, { agent, signature });
    });
  }
  certificate(epoch: Epoch, now = Date.now()): ConfirmationCertificate {
    const { live, p } = this.checked(epoch, now);
    const votes = live.committee.flatMap((c) => {
      const v = this.db.get<{ agent: string; signature: string }>(
        "confirmation-vote",
        `${epoch.id}:${c.id}`,
      );
      return v ? [v] : [];
    });
    const cert = { ...p.descriptor, votes, confirmedAt: now };
    if (votes.length < confirmationQuorum(live.committee.length))
      throw new ConfirmationPending("confirmation quorum pending");
    if (
      !verifyConfirmation(
        p.options.chainId,
        p.output,
        p.signature,
        cert,
        live.committee,
        live.configHash,
      )
    )
      throw Error("invalid confirmation certificate");
    return cert;
  }
}
