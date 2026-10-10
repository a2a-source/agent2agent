import { verifyPublishedEpoch } from "./confirmation.js";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { validateReportSections } from "./report-templates.js";
import { researchChecks, validateC4Targets } from "./research-facts.js";
import { hash, type Candidate } from "./protocol.js";
import { Agents } from "./agents.js";
import { Epochs, type Epoch } from "./epochs.js";
import type { Config } from "./config.js";
import {
  ResearchTasks,
  balancedAssignments,
  assignmentSchema,
} from "./tasks.js";
import type { Observation, ResearchTool } from "./agent-runtime.js";
import { ResearchData, contextTools } from "./research-data.js";
import {
  assertResearchAssets,
  contextSchema,
  evidence,
  normalizeEvidence,
  promptSnapshot,
  type ResearchContext,
} from "./research-context.js";
import {
  normalizeReport,
  evidenceRef,
  decisionSchema,
  researchReportSchema,
  validateResearchDecision,
  qspV2Schema,
  type ResearchReport,
} from "./qsp-v2.js";
import {
  toolEvidenceBrief,
  retainReportEvidence,
  validateRoleCoverage,
  validateNewsBodyClaims,
} from "./research-guidance.js";

type Call = (
  agent: string,
  id: string,
  system: string,
  input: string,
  tools?: ResearchTool[],
  observations?: Observation[],
  outputSchema?: Record<string, unknown>,
) => Promise<any>;
export async function buildResearchPackage(p: {
  agents: Agents;
  epochs: Epochs;
  config: Config;
  epoch: Epoch;
  workers: Candidate[];
  version: string;
  tasks: ResearchTasks;
  call: Call;
  fence: () => void;
  signal: AbortSignal;
}) {
  const {
      agents,
      epochs,
      config,
      epoch,
      workers,
      version,
      tasks,
      call,
      fence,
      signal,
    } = p,
    db = agents.db,
    runId = `${epoch.id}:${epoch.view}`;
  let saved = db.get<{
    version: string;
    hash: string;
    context: ResearchContext;
  }>("research-context", epoch.id);
  if (
    saved &&
    (saved.version !== version || saved.hash !== hash(saved.context))
  )
    throw Error("research context conflict");
  if (!saved) {
    const previous = db
      .all<Epoch>("epoch")
      .filter(
        (e) =>
          e.status === "PUBLISHED" &&
          e.slot < epoch.slot &&
          (e.output as any)?.version === "a2a-qsp/2",
      )
      .sort((a, b) => b.slot - a.slot)[0];
    let prior = null;
    if (previous) {
      const output = qspV2Schema.parse(previous.output);
      if (!verifyPublishedEpoch(config.chain.id, previous))
        throw Error("previous QSP signature or confirmation invalid");
      prior = {
        epoch: previous.id,
        hash: hash(output),
        signals: output.signals,
        context: output.context,
      };
    }
    const context = await new ResearchData(db, config.research).collect(
      prior,
      signal,
      epoch.id,
    );
    fence();
    saved = { version, hash: hash(context), context };
    db.insert("research-context", epoch.id, saved);
  }
  const context = contextSchema.parse(saved.context),
    contextHash = saved.hash;
  assertResearchAssets(
    context.chainId,
    context.universe,
    context.testnetProfile,
  );
  const promptContext = promptSnapshot(context);
  const fresh = () => {
    fence();
    if (Date.now() - context.at > config.research.maxAgeMs)
      throw Error("research context data expired");
  };
  fresh();
  const final = db.get<unknown>("research-final", runId);
  if (final) {
    const output = qspV2Schema.parse(final);
    if (output.contextHash !== contextHash || Date.now() > output.validUntil)
      throw Error("research final context mismatch or data expired");
    return output;
  }
  const plan = await tasks.execute(
    `${runId}:plan`,
    [epoch.master],
    epoch.deadline,
    fresh,
    (agent, id) =>
      call(
        agent,
        id,
        config.masterPrompt,
        JSON.stringify({
          task: "Return JSON {assignments:[{role,agent}]}. Assign each role exactly once to supplied workers. Balance counts across workers.",
          roles: config.roles.map((r) => r.id),
          workers: workers.map((w) => w.id),
          context: promptContext,
        }),
        [],
        undefined,
        config.agent.finalOutputMode === "tool"
          ? toJsonSchema(assignmentSchema)
          : undefined,
      ),
    { version, contextHash, workers },
  );
  const assignment = balancedAssignments(
    plan,
    config.roles.map((r) => r.id),
    workers.map((w) => w.id),
  );
  db.put("research-assignment", runId, {
    ...assignment,
    protocol: "balanced-round-robin/1",
    contextHash,
  });
  const reports = await tasks.map(config.roles, async (role) => {
    const first = assignment.assignments.find((a) => a.role === role.id)!.agent;
    return tasks.execute(
      `${runId}:report:${role.id}`,
      [first, ...workers.filter((w) => w.id !== first).map((w) => w.id)],
      epoch.deadline,
      fresh,
      async (agent, id, feedback) => {
        const observations: Observation[] = [];
        const raw = await call(
          agent,
          id,
          role.prompt +
            ' Return exactly one valid JSON object matching requiredOutput at the ROOT, no wrapper, comments or markdown. reportTemplate describes sections ONLY; all other root fields are still mandatory. Also include sections:[{id,content,evidenceRefs:[]}] in EXACT supplied reportTemplate section order. Each output section contains only id, content, evidenceRefs; do not copy template title or instruction. Every sections[].content must be a plain string of 1–2400 characters. Fill every section with actual findings or explicit missing data; evidenceRefs use frozen E refs or exact tool source URLs. Example shape: {"summary":"brief findings","missing":[],"evidenceIds":["E1"],"recommendation":"conditional analysis","uncertainty":"limitations"}. missing and evidenceIds MUST be JSON arrays even for one item, never strings. Replace example values with actual research. evidenceIds must cite exact context.evidence ref values such as E1. Do not output a sources field: the protocol resolves IDs to URLs. For news, select concise material items across all configured assets; do not dump every searched item. Preserve each selected exact headline, source timestamp, publisherUrl and honest FULL_TEXT/HEADLINE_ONLY status. If publisher resolution failed, use publisherUrl=UNKNOWN and state the limitation; retain the exact observed wrapper URL in evidenceRefs, never relabel it as a publisher URL. State when other discovered headlines were omitted. Keep each section within 2400 characters without shortening exact headlines or URLs or inventing evidence. Keep summaries concise; all amounts must agree with context. Missing data is not zero. Use context.accountingBrief to report verified matched-wallet window PnL and network results separately; unknown lifetime cost basis must not erase known execution history. Latest terminal UNKNOWN does not erase an older KNOWN execution window. Cite accounting evidence.',
          JSON.stringify({
            requiredOutput: {
              summary: "brief factual summary",
              missing: [],
              evidenceIds: [],
              recommendation: "role-specific recommendation",
              uncertainty: "limitations",
              sections: config.reportTemplates[role.id]!.sections.map((s) => ({
                id: s.id,
                content: "actual findings or explicit missing data",
                evidenceRefs: [],
              })),
            },
            reportTemplate: config.reportTemplates[role.id],
            validationFeedback: feedback,
            identity: {
              agent,
              epoch: epoch.id,
              view: epoch.view,
              role: role.id,
            },
            researchScope: {
              assets: context.universe.map((a) => ({
                symbol: a.symbol,
                referenceMarket: a.marketSymbol,
                chainId: context.chainId,
                asset: a.address,
              })),
              objective:
                "Provide role-specific facts and analysis for every configured asset. Use context.facts for funding and limits. Zero token holdings do not prevent BUY when native funding exists; SELL requires holdings. Leave other specialties to their roles. Clearly separate observed evidence, inference, missing data and conditional recommendations; do not invent metrics or sources.",
              toolsAvailable: config.agent.toolsEnabled
                ? contextTools(context, role.id).map((t) => t.name)
                : [],
            },
            context: promptSnapshot(context, role.id),
          }),
          config.agent.toolsEnabled ? contextTools(context, role.id) : [],
          observations,
          toJsonSchema(
            researchReportSchema
              .omit({ sources: true })
              .required({ sections: true }),
          ),
        );
        if (config.agent.toolsEnabled)
          validateRoleCoverage(role.id, context, observations);
        const parsed = normalizeReport(raw, context);
        validateNewsBodyClaims(role.id, parsed, observations);
        const extra: ResearchReport["additionalEvidence"] = [];
        for (const o of observations) {
          const e = evidence("web", `tool://${o.tool}`, null, o);
          db.put("research-evidence", e.id, {
            ...e,
            data: normalizeEvidence(o),
          });
          extra.push(e);
          for (const s of o.output?.sources ?? []) {
            if (typeof s.url !== "string") continue;
            const citation = evidence(
              "web",
              s.url,
              Number.isSafeInteger(s.publishedAt) ? s.publishedAt : null,
              { observationHash: e.contentHash, source: s },
              e.retrievedAt,
            );
            db.put("research-evidence", citation.id, {
              ...citation,
              data: { observationHash: e.contentHash, source: s },
            });
            extra.push(citation);
          }
        }
        const retained = retainReportEvidence(extra, [
          ...parsed.sources,
          ...(parsed.sections ?? []).flatMap((s) => s.evidenceRefs),
        ]);
        validateReportSections(
          config.reportTemplates[role.id]!,
          parsed.sections,
          new Set(
            [...context.evidence, ...retained].flatMap((e) => [e.id, e.url]),
          ),
        );
        const urls = new Set(
          [...context.evidence, ...retained].map((e) => e.url),
        );
        if (
          parsed.sources.some((s) => !urls.has(s)) ||
          parsed.evidenceIds.some(
            (id) => !context.evidence.some((e) => e.id === id),
          )
        )
          throw Error("fabricated research evidence");
        const report: ResearchReport = {
          ...parsed,
          missing: [...new Set([...parsed.missing, ...context.missing])].slice(
            0,
            32,
          ),
          role: role.id,
          agent,
          contextHash,
          additionalEvidence: retained,
        };
        fresh();
        db.put("report", `${epoch.id}:report:${role.id}`, {
          version,
          view: epoch.view,
          contextHash,
          report,
        });
        return report;
      },
      { version, role, contextHash, assignment },
    );
  });
  const result = await tasks.execute(
    `${runId}:synthesis`,
    [epoch.master],
    epoch.deadline,
    fresh,
    async (agent, id, feedback) => {
      const raw = await call(
        agent,
        id,
        config.masterPrompt,
        JSON.stringify({
          task: 'Return JSON {sections:[{id,content,evidenceRefs:[]}],summary:string,decisions:[{role,decision:"ACCEPT"|"REJECT"|"QUALIFY",reason:string}],disagreements:string[],signals:[{chainId,asset,action:"BUY"|"SELL"|"HOLD",targetWeightBps,rationale,evidence:string[],conditions:string[],invalidation:string[],maxSlippageBps}],risks:string[]}. Fill sections in supplied reportTemplate order; evidenceRefs use frozen E refs or exact provided source URLs. Cover every role exactly once in decisions. Evidence references context.evidence IDs cited by reports. Include networkAllocation and stableNetworkAllocation as independent fields. For either common allocation, null means no supported common recommendation; insufficient evidence calls for null, never zero as a placeholder. A zero asset target explicitly requests zero desired exposure and can cause independent wallets to reduce that asset. An evidenced, defensible all-zero allocation is valid. signals=[] means no wallet-specific proposals; it does not imply no wallet action when a non-null common allocation exists. Explain wallet-specific proposals separately from common market targets, and keep the summary consistent with both. Missing historical cost basis or PnL does not itself invalidate known balances/current valuation or require a common target. Do not force nonzero targets or trades. Targets are desired portfolio weights, not order amounts. Unknown portfolio/valuation or absent market evidence prohibits signals. SELL requires actual holdings; HOLD preserves current weight; BUY increases target and requires observed liquidity. Respect context.policy. Explain decisions using context and reports, preserve material disagreement. Prior signals are unexecuted. Reconcile blanket claims of no accounting history against context.accountingBrief. Distinguish verified matched-wallet execution-window profit, latest inter-observation return, network totals and unknown lifetime USDT cost basis; cite each source window and evidence.',
          context: promptContext,
          reportTemplate: config.reportTemplates.master,
          networkAllocationInstructions: {
            scope: "NETWORK_MODEL_PORTFOLIO",
            instruction:
              "Return networkAllocation=null if common market allocation lacks evidence. Otherwise use {version:'network-allocation/1',scope:'NETWORK_MODEL_PORTFOLIO',targets:[{asset,targetWeightBps,evidence:[],rationale}],limitations:[]}. Cover EVERY configured asset including explicit zero targets. This is a model portfolio independent of the observed wallet. Do not infer targets from its holdings, overweight correction or wallet-specific signals. Cite frozen market evidence used by role reports for every asset. Positive weights require fresh observed liquidity and citation of that matching frozen DEX pool evidence as well as market evidence. Follow context.policy caps; residual allocation is volatile native BNB, not stable cash. Preserve limitations and uncertainty. These are research targets, not authorization or conditional executable orders. Do not invent targets just to populate the field.",
          },
          stableNetworkAllocationInstructions: {
            scope: "NETWORK_MODEL_PORTFOLIO",
            configuredAssets: context.universe,
            testnetProfile: context.testnetProfile ?? null,
            instruction:
              "For stable-reserve independent-wallet research, return stableNetworkAllocation=null when evidence is insufficient or the configured universe does not cover all three underlying reference markets BTCUSDT, ETHUSDT and BNBUSDT. Use the exact addresses and symbols in configuredAssets, whose registry/profile has been validated. BTCB/ETH/WBNB are mainnet examples, not required literal symbols for a signed test profile. Test-profile market trends are underlying reference evidence, not proof of token backing or executable prices. Otherwise use {version:'stable-network-allocation/1',scope:'NETWORK_MODEL_PORTFOLIO',reserve:'ALLOWLISTED_STABLECOINS',nativeBnb:'INCLUDED_IN_BNB_TARGET',targets:[{asset,targetWeightBps,evidence:[],rationale}],limitations:[]}. Explicitly cover all three configured assets. Native BNB and the configured BNBUSDT token share the BNB target; residual is allowlisted stablecoins, not native BNB. Each underlying target is at most min(2000,context.policy.maxAssetBps); total is at most min(6000,context.policy.maxTotalBps). Use fresh frozen role-cited market evidence for every asset and matching frozen DEX evidence for positive weights. Do not copy wallet-specific holdings corrections, reinterpret networkAllocation, assume a stablecoin quote/peg, or force targets. This is independently evidenced shared allocation, not execution authority.",
          },
          signalEvidenceRequirements: promptContext.markets.map((m) => ({
            asset: m.asset,
            symbol: m.symbol,
            requiredMarketEvidence: m.evidence,
            rule: "Every signal for this asset must cite this frozen market evidence, including risk-driven SELL; portfolio or pool citations alone are insufficient.",
          })),
          requiredOutput: {
            sections: config.reportTemplates.master!.sections.map((s) => ({
              id: s.id,
              content:
                "Replace with concise evidence-based findings or explicit gaps",
              evidenceRefs: [],
            })),
            summary: "Replace with concise synthesis",
            decisions: reports.map((r) => ({
              role: r.role,
              decision: "QUALIFY",
              reason:
                "Replace with evidence-based acceptance, rejection or qualification",
            })),
            disagreements: [],
            signals: [],
            networkAllocation: null,
            stableNetworkAllocation: null,
            risks: [
              "Replace with an evidence-based risk or explicit limitation",
            ],
          },
          outputRules:
            "Return ALL requiredOutput root fields, including at least one actual risk or limitation in risks. Sections have ONLY id, content, evidenceRefs. Trade fields (conditions, invalidation, maxSlippageBps) belong ONLY inside signals entries. Do not copy example judgments; decide from evidence. Keep each section under 1200 characters and each decision reason under 300 characters.",
          validationFeedback: feedback,
          reports: reports.map(
            ({
              role,
              summary,
              recommendation,
              uncertainty,
              evidenceIds,
              missing,
              additionalEvidence,
              sections,
            }) => ({
              role,
              summary,
              sections,
              recommendation,
              uncertainty,
              evidenceIds,
              missing,
              toolEvidence: toolEvidenceBrief(db, additionalEvidence),
            }),
          ),
        }),
        [],
        undefined,
        toJsonSchema(decisionSchema.required({ sections: true })),
      );
      const result = decisionSchema.parse(raw);
      for (const s of result.signals)
        s.evidence = s.evidence.map((id) => evidenceRef(id, context).id);
      for (const target of [
        ...(result.networkAllocation?.targets ?? []),
        ...(result.stableNetworkAllocation?.targets ?? []),
      ])
        target.evidence = target.evidence.map(
          (id) => evidenceRef(id, context).id,
        );
      if (result.sections)
        for (const section of result.sections)
          section.evidenceRefs = section.evidenceRefs.map((ref) =>
            /^E[1-9][0-9]*$/.test(ref) ? evidenceRef(ref, context).id : ref,
          );
      validateReportSections(
        config.reportTemplates.master!,
        result.sections,
        new Set(
          [
            ...context.evidence,
            ...reports.flatMap((r) => r.additionalEvidence),
          ].flatMap((e) => [e.id, e.url]),
        ),
      );
      validateC4Targets(result.signals, context);
      return validateResearchDecision(
        result,
        context,
        reports,
        Date.now(),
        config.research.maxAgeMs,
      );
    },
    { version, contextHash, reports },
  );
  fresh();
  validateResearchDecision(
    result,
    context,
    reports,
    Date.now(),
    config.research.maxAgeMs,
  );
  const createdAt = Date.now(),
    { signals, risks, ...masterSummary } = result;
  const output = qspV2Schema.parse({
    version: "a2a-qsp/2",
    epoch: epoch.id,
    view: epoch.view,
    master: epoch.master,
    committeeHash: hash(epoch.committee),
    configHash: hash({ network: epoch.configHash, research: version }),
    contextHash,
    context,
    createdAt,
    validUntil: createdAt + context.policy.validForMs,
    dataAt: context.markets.length
      ? Math.min(...context.markets.map((m) => m.asOf))
      : 0,
    reports,
    masterSummary,
    signals,
    policyTextVersion: "c4-hard-risk-conditions/1",
    risks,
    reportTemplates: config.reportTemplates,
    researchChecks: researchChecks(context),
    executed: false,
  });
  db.insert("research-final", runId, output);
  return output;
}
