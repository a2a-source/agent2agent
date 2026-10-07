import { hash, type Candidate } from "./protocol.js";
import { Agents } from "./agents.js";
import { Epochs, type Epoch } from "./epochs.js";
import type { Config } from "./config.js";
import { ResearchTasks, balancedAssignments } from "./tasks.js";
import type { Observation, ResearchTool } from "./agent-runtime.js";
import { ResearchData, contextTools } from "./research-data.js";
import {
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
  validateResearchDecision,
  qspV2Schema,
  type ResearchReport,
} from "./qsp-v2.js";
import { verifyQsp } from "./qsp.js";
type Call = (
  agent: string,
  id: string,
  system: string,
  input: string,
  tools?: ResearchTool[],
  observations?: Observation[],
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
      if (
        !verifyQsp(
          config.chain.id,
          output,
          previous.signature!,
          agents.get(previous.master).wallet,
        )
      )
        throw Error("previous QSP signature invalid");
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
    );
    fence();
    saved = { version, hash: hash(context), context };
    db.insert("research-context", epoch.id, saved);
  }
  const context = contextSchema.parse(saved.context),
    contextHash = saved.hash;
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
      async (agent, id) => {
        const observations: Observation[] = [];
        const raw = await call(
          agent,
          id,
          role.prompt +
            " Return JSON {summary:string,missing:string[],evidenceIds:string[],recommendation:string,uncertainty:string}. evidenceIds must cite exact context.evidence ref values such as E1. Do not output a sources field: the protocol resolves IDs to URLs. Keep summaries concise; all amounts must agree with context. Missing data is not zero.",
          JSON.stringify({
            identity: {
              agent,
              epoch: epoch.id,
              view: epoch.view,
              role: role.id,
            },
            context: promptContext,
          }),
          config.agent.toolsEnabled ? contextTools(context, role.id) : [],
          observations,
        );
        const parsed = normalizeReport(raw, context);
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
        const urls = new Set([...context.evidence, ...extra].map((e) => e.url));
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
          additionalEvidence: extra.slice(0, 64),
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
    async (agent, id) => {
      const raw = await call(
        agent,
        id,
        config.masterPrompt,
        JSON.stringify({
          task: 'Return JSON {summary:string,decisions:[{role,decision:"ACCEPT"|"REJECT"|"QUALIFY",reason:string}],disagreements:string[],signals:[{chainId,asset,action:"BUY"|"SELL"|"HOLD",targetWeightBps,rationale,evidence:string[],conditions:string[],invalidation:string[],maxSlippageBps}],risks:string[]}. Cover every role exactly once in decisions. Evidence references context.evidence IDs cited by reports. Empty signals are valid; do not force trades. Targets are desired portfolio weights, not order amounts. Unknown portfolio/valuation or absent market evidence prohibits signals. SELL requires actual holdings; HOLD preserves current weight; BUY increases target and requires observed liquidity. Respect context.policy. Explain decisions using context and reports, preserve material disagreement. Prior signals are unexecuted.',
          context: promptContext,
          reports: reports.map(
            ({
              role,
              summary,
              recommendation,
              uncertainty,
              evidenceIds,
              missing,
            }) => ({
              role,
              summary,
              recommendation,
              uncertainty,
              evidenceIds,
              missing,
            }),
          ),
        }),
      );
      const result = decisionSchema.parse(raw);
      for (const s of result.signals)
        s.evidence = s.evidence.map((id) => evidenceRef(id, context).id);
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
    risks,
    executed: false,
  });
  db.insert("research-final", runId, output);
  return output;
}
