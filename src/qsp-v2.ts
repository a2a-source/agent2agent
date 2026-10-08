import {
  templateSchema,
  reportSectionSchema,
  validateReportSections,
} from "./report-templates.js";
import { z } from "zod";
import { validateC4Targets, verifyResearchChecks } from "./research-facts.js";
import { isAddress } from "ethers";
import { hash } from "./protocol.js";
import {
  contextSchema,
  assertResearchAssets,
  evidenceSchema,
  type ResearchContext,
} from "./research-context.js";
const text = z.string().min(1).max(4000),
  strings = z.array(text).max(32),
  bps = z.number().int().min(0).max(10000);
export const researchReportSchema = z
  .object({
    sections: z.array(reportSectionSchema).max(8).optional(),
    summary: text,
    sources: z.array(z.string().url()).max(32).default([]),
    missing: strings,
    evidenceIds: z.array(z.string()).max(32),
    recommendation: text,
    uncertainty: text,
  })
  .strict();
export function evidenceRef(id: string, context: ResearchContext) {
  const direct = context.evidence.find((e) => e.id === id);
  if (direct) return direct;
  const index = /^E([1-9][0-9]*)$/.exec(id);
  const found = index ? context.evidence[Number(index[1]) - 1] : undefined;
  if (!found) throw Error("fabricated research evidence");
  return found;
}
export function normalizeReport(raw: unknown, context: ResearchContext) {
  const report = researchReportSchema.parse(raw);
  if (report.sections)
    for (const section of report.sections)
      section.evidenceRefs = section.evidenceRefs.map((ref) =>
        /^E[1-9][0-9]*$/.test(ref) ? evidenceRef(ref, context).id : ref,
      );
  const refs = report.evidenceIds.map((id) => evidenceRef(id, context));
  return {
    ...report,
    evidenceIds: [...new Set(refs.map((e) => e.id))],
    sources: [...new Set([...report.sources, ...refs.map((e) => e.url)])],
  };
}
export const researchSignalSchema = z
  .object({
    chainId: z.number().int().positive(),
    asset: z.string().refine(isAddress),
    action: z.enum(["BUY", "SELL", "HOLD"]),
    targetWeightBps: bps,
    rationale: text,
    evidence: z.array(z.string()).min(1).max(24),
    conditions: strings.min(1),
    invalidation: strings.min(1),
    maxSlippageBps: bps,
  })
  .strict();
export const decisionSchema = z
  .object({
    sections: z.array(reportSectionSchema).max(8).optional(),
    summary: text,
    decisions: z
      .array(
        z
          .object({
            role: z.string(),
            decision: z.enum(["ACCEPT", "REJECT", "QUALIFY"]),
            reason: text,
          })
          .strict(),
      )
      .min(1)
      .max(24),
    disagreements: strings,
    signals: z.array(researchSignalSchema).max(24),
    risks: strings.min(1),
  })
  .strict();
export type ResearchReport = z.infer<typeof researchReportSchema> & {
  role: string;
  agent: string;
  contextHash: string;
  additionalEvidence: z.infer<typeof evidenceSchema>[];
};
export function validateResearchDecision(
  raw: unknown,
  context: ResearchContext,
  reports: Pick<ResearchReport, "role" | "evidenceIds">[],
  now: number,
  maxAgeMs: number,
) {
  const d = decisionSchema.parse(raw),
    roles = reports.map((r) => r.role),
    covered = d.decisions.map((x) => x.role);
  if (
    new Set(roles).size !== roles.length ||
    new Set(covered).size !== covered.length ||
    roles.length !== covered.length ||
    roles.some((r) => !covered.includes(r))
  )
    throw Error("Master decisions must cover every role exactly once");
  if (now - context.at > maxAgeMs || context.at > now + 30000)
    throw Error("research context data expired");
  const seen = new Set<string>();
  let total = 0;
  for (const s of d.signals) {
    const key = s.asset.toLowerCase(),
      asset = context.universe.find((a) => a.address.toLowerCase() === key),
      market = context.markets.find((m) => m.address.toLowerCase() === key);
    if (s.chainId !== context.chainId || !asset || seen.has(key))
      throw Error("signal asset not in research universe or duplicate");
    seen.add(key);
    if (!market || now - market.asOf > maxAgeMs || market.asOf > now)
      throw Error("market data expired or unavailable");
    if (
      !s.evidence.includes(market!.evidenceId) ||
      s.evidence.some(
        (id) =>
          !context.evidence.some((e) => e.id === id) ||
          !reports.some((r) => r.evidenceIds.includes(id)),
      )
    )
      throw Error("signal lacks fresh verified market evidence");
    if (context.portfolio.status === "UNKNOWN")
      throw Error("signal portfolio unavailable");
    if (
      s.targetWeightBps > context.policy.maxAssetBps ||
      s.maxSlippageBps > context.policy.maxSlippageBps
    )
      throw Error("signal exceeds risk policy");
    total += s.targetWeightBps;
    const position = context.portfolio.positions.find(
        (p) => p.address.toLowerCase() === key,
      ),
      qty = BigInt(position?.quantity ?? "0");
    const value = context.portfolio.valueMicros;
    if (value === null) throw Error("portfolio valuation unavailable");
    if (s.action === "BUY" && BigInt(value) === 0n)
      throw Error("BUY requires investable capital");
    const current =
      BigInt(value) > 0n
        ? Number(
            (BigInt(position?.valueMicros ?? "0") * 10000n) / BigInt(value),
          )
        : 0;
    if (s.action === "SELL" && (qty === 0n || s.targetWeightBps >= current))
      throw Error("SELL requires actual holdings and lower target");
    if (
      s.action === "BUY" &&
      (s.targetWeightBps <= current ||
        !context.liquidity.some(
          (l) =>
            l.asset.toLowerCase() === key &&
            l.liquidityUsd >= context.policy.minLiquidityUsd &&
            now - l.observedAt <= maxAgeMs,
        ))
    )
      throw Error("BUY requires larger target and observed liquidity");
    if (s.action === "HOLD" && s.targetWeightBps !== current)
      throw Error("HOLD cannot change current weight");
  }
  // Omitted existing exposures remain held; adding a signal cannot evade total policy.
  if (d.signals.length) {
    const value = BigInt(context.portfolio.valueMicros ?? "0");
    if (value > 0n)
      for (const p of context.portfolio.positions)
        if (
          p.address !== "0x0000000000000000000000000000000000000000" &&
          !seen.has(p.address.toLowerCase())
        ) {
          const weight = Number(
            (BigInt(p.valueMicros ?? "0") * 10000n) / value,
          );
          if (weight > context.policy.maxAssetBps)
            throw Error("omitted position exceeds per-asset policy");
          total += weight;
        }
  }
  if (total > context.policy.maxTotalBps)
    throw Error("aggregate target exceeds risk policy");
  return d;
}
export const qspV2Schema = z
  .object({
    version: z.literal("a2a-qsp/2"),
    epoch: z.string(),
    view: z.number().int().nonnegative(),
    master: z.string(),
    committeeHash: z.string(),
    configHash: z.string(),
    dataAt: z.number().int().nonnegative(),
    createdAt: z.number().int(),
    validUntil: z.number().int(),
    contextHash: z.string(),
    context: contextSchema,
    reports: z
      .array(
        researchReportSchema.extend({
          role: z.string(),
          agent: z.string(),
          contextHash: z.string(),
          additionalEvidence: z.array(evidenceSchema).max(64),
        }),
      )
      .min(1)
      .max(24),
    masterSummary: decisionSchema.omit({ signals: true, risks: true }),
    signals: z.array(researchSignalSchema).max(24),
    risks: strings.min(1),
    reportTemplates: z.record(templateSchema).optional(),
    researchChecks: z
      .object({
        profile: z.literal("c4/1"),
        facts: z.record(z.unknown()),
        currentViolations: z.array(
          z.object({ code: z.string(), asset: z.string() }).strict(),
        ),
        hardRules: z.literal("HARD_POLICY_OVERRIDES_TEXT_CONDITIONS"),
      })
      .strict()
      .optional(),
    executed: z.literal(false),
  })
  .strict()
  .superRefine((q, ctx) => {
    try {
      if (q.researchChecks) {
        verifyResearchChecks(q.researchChecks, q.context);
        validateC4Targets(q.signals, q.context);
      }
      if (q.reportTemplates) {
        const refs = (extra: typeof q.context.evidence) =>
          new Set(
            [...q.context.evidence, ...extra].flatMap((e) => [e.id, e.url]),
          );
        for (const r of q.reports) {
          const template = q.reportTemplates[r.role];
          if (!template) throw Error("report template missing");
          validateReportSections(
            template,
            r.sections,
            refs(r.additionalEvidence),
          );
        }
        const master = q.reportTemplates.master;
        if (!master) throw Error("master report template missing");
        validateReportSections(
          master,
          q.masterSummary.sections,
          refs(q.reports.flatMap((r) => r.additionalEvidence)),
        );
      }
      assertResearchAssets(q.context.chainId, q.context.universe);
      validateResearchDecision(
        { ...q.masterSummary, signals: q.signals, risks: q.risks },
        q.context,
        q.reports,
        q.createdAt,
        q.context.policy.dataMaxAgeMs ?? 600000,
      );
      const dataAt = q.context.markets.length
        ? Math.min(...q.context.markets.map((m) => m.asOf))
        : 0;
      if (q.dataAt !== dataAt) throw Error("data timestamp mismatch");
      for (const e of [
        ...q.context.evidence,
        ...q.reports.flatMap((r) => r.additionalEvidence),
      ]) {
        const { id, ...metadata } = e;
        if (id !== hash(metadata))
          throw Error("evidence metadata hash mismatch");
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "research package policy or evidence invalid",
      });
    }
    if (
      q.contextHash !== hash(q.context) ||
      q.reports.some((r) => r.contextHash !== q.contextHash) ||
      q.validUntil !== q.createdAt + q.context.policy.validForMs
    )
      ctx.addIssue({
        code: "custom",
        message: "context hash or validity mismatch",
      });
    const allowed = new Set(q.context.evidence.map((e) => e.id));
    for (const r of q.reports) {
      const urls = new Set(
        [...q.context.evidence, ...r.additionalEvidence].map((e) => e.url),
      );
      if (
        r.evidenceIds.some((id) => !allowed.has(id)) ||
        r.sources.some((url) => !urls.has(url))
      )
        ctx.addIssue({ code: "custom", message: "report fabricated evidence" });
    }
  });
