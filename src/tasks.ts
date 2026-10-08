import { hash } from "./protocol.js";
import { Store } from "./store.js";
export interface ResearchFeedback {
  code: string;
  instruction: string;
}
export function validationFeedback(error: unknown): ResearchFeedback {
  if ((error as any)?.name === "ZodError")
    return {
      code: "OUTPUT_FORMAT",
      instruction:
        "Your root JSON must contain ALL required fields. Role report: summary (string), missing (array), evidenceIds (array), recommendation (string), uncertainty (string), sections (array of id/content/evidenceRefs). Returning only sections is invalid. Master requires summary, sections, decisions, disagreements, signals and risks. Follow requiredOutput exactly; no wrapper.",
    };
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("research coverage incomplete:"))
    return {
      code: "ROLE_COVERAGE",
      instruction:
        "Complete your required tool attempts before final report: market needs market_klines for every configured symbol; news needs news_search for Bitcoin, Ethereum and BNB and an attempted fetch_page for an actual source; macro needs an official fetch_page. Report source failures as missing, never as successful research. Do not stop after only one asset.",
    };
  if (/policy|target|weight|holdings|capital|HOLD/i.test(message))
    return {
      code: "RISK_POLICY",
      instruction:
        "Recompute targets from context.facts; respect per-asset and total limits, actual holdings and action direction. Hard policy cannot be cancelled by market conditions.",
    };
  if (/evidence/i.test(message))
    return {
      code: "EVIDENCE",
      instruction:
        "Cite only supplied evidence references; each signal needs fresh market evidence cited by a role.",
    };
  return {
    code: "OUTPUT_FORMAT",
    instruction:
      "Return the requested valid JSON schema including every reportTemplate section in order, with content and evidenceRefs arrays; cover each role exactly once, use arrays, and check required fields against the task.",
  };
}
export type ResearchFailure =
  "PLATFORM" | "PROVIDER" | "DATA" | "WORKER" | "INVALID_OUTPUT";
export class ResearchTaskError extends Error {
  constructor(readonly failure: ResearchFailure) {
    super("prior research attempt failed");
  }
}
export function classifyResearchFailure(error: unknown): ResearchFailure {
  if (error instanceof ResearchTaskError) return error.failure;
  if (error instanceof SyntaxError || (error as any)?.name === "ZodError")
    return "INVALID_OUTPUT";
  const message = error instanceof Error ? error.message : String(error);
  if (
    /LLM HTTP|LLM request limit|LLM API key|fetch|LLM usage|LLM content|provider|uncertain LLM|timeout/i.test(
      message,
    )
  )
    return "PROVIDER";
  if (/ineligible|compute budget/i.test(message)) return "WORKER";
  if (/fabricated/i.test(message)) return "INVALID_OUTPUT";
  if (/source|data expired|BNB\/USD oracle/i.test(message)) return "DATA";
  if (
    error instanceof SyntaxError ||
    (error as any)?.name === "ZodError" ||
    /validation|fabricated|invalid Master|evidence|Zod|^signal |^C4 policy|^aggregate target|^omitted position|^portfolio valuation|^HOLD |^BUY |^SELL |^Master decisions|^Agent final JSON unavailable|^research coverage incomplete:|^report template/i.test(
      message,
    )
  )
    return "INVALID_OUTPUT";
  return "PLATFORM";
}
export function balancedAssignments(
  raw: unknown,
  roles: string[],
  workers: string[],
) {
  if (!workers.length) throw Error("no healthy workers");
  const candidate = (raw as any)?.assignments;
  const assignments: { role: string; agent: string }[] = Array.isArray(
    candidate,
  )
    ? candidate.filter(
        (a) => a && typeof a.role === "string" && typeof a.agent === "string",
      )
    : [];
  const counts = workers.map(
    (w) => assignments.filter((a) => a.agent === w).length,
  );
  const valid =
    Array.isArray(candidate) &&
    assignments.length === candidate.length &&
    assignments.length === roles.length &&
    new Set(assignments.map((a) => a.role)).size === roles.length &&
    assignments.every(
      (a) => roles.includes(a.role) && workers.includes(a.agent),
    ) &&
    Math.max(...counts) - Math.min(...counts) <= 1;
  return {
    repaired: !valid,
    assignments: valid
      ? assignments!
      : roles.map((role, i) => ({ role, agent: workers[i % workers.length]! })),
  };
}
interface Attempt {
  id: string;
  agent: string;
  status: "RUNNING" | "DONE" | "FAILED";
  result?: unknown;
  failure?: ResearchFailure;
  contextHash?: string;
  feedback?: ResearchFeedback;
}
export interface ResearchOptions {
  resumable?: boolean;
  concurrency?: number;
  maxAttempts?: number;
}
export class ResearchTasks {
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly resumable: boolean;
  constructor(
    readonly db: Store,
    options: ResearchOptions = {},
  ) {
    this.resumable = options.resumable ?? false;
    this.concurrency = Math.min(
      16,
      Math.max(1, Math.floor(options.concurrency ?? 3)),
    );
    this.maxAttempts = Math.min(
      8,
      Math.max(1, Math.floor(options.maxAttempts ?? 2)),
    );
  }
  async map<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
    const result: R[] = [];
    let cursor = 0;
    let failed = false;
    const outcomes = await Promise.allSettled(
      Array.from(
        { length: Math.min(items.length, this.concurrency) },
        async () => {
          while (!failed) {
            const index = cursor++;
            if (index >= items.length) return;
            try {
              result[index] = await work(items[index]!);
            } catch (e) {
              failed = true;
              throw e;
            }
          }
        },
      ),
    );
    const rejection = outcomes.find((o) => o.status === "rejected");
    if (rejection?.status === "rejected") throw rejection.reason;
    return result;
  }
  async execute<T>(
    key: string,
    workers: string[],
    deadline: number,
    fence: () => void,
    work: (
      agent: string,
      id: string,
      feedback?: ResearchFeedback,
    ) => Promise<T>,
    context: unknown = key,
  ): Promise<T> {
    const contextHash = hash({ workers, context });
    let last: unknown = Error("research attempts exhausted");
    let feedback: ResearchFeedback | undefined;
    for (let i = 0; i < this.maxAttempts; i++) {
      fence();
      if (Date.now() >= deadline) throw Error("epoch deadline expired");
      const id = `${key}:attempt:${i}`,
        prior = this.db.get<Attempt>("research-attempt", id);
      if (prior?.contextHash && prior.contextHash !== contextHash)
        throw Error("research attempt context conflict");
      if (prior?.status === "DONE") {
        if (!workers.includes(prior.agent))
          throw Error("research attempt author unavailable");
        if (!prior.contextHash)
          throw Error("research attempt context unavailable");
        return prior.result as T;
      }
      // Only a ledger-backed framework may safely replay an interrupted identity.
      const resume =
        this.resumable &&
        prior?.status === "RUNNING" &&
        prior.contextHash === contextHash &&
        workers.includes(prior.agent);
      if (prior && !resume) {
        if (prior.failure === "DATA" || prior.failure === "PLATFORM")
          throw new ResearchTaskError(prior.failure);
        feedback = prior.feedback;
        last = new ResearchTaskError(prior.failure ?? "PLATFORM");
        continue;
      }
      const agent = resume ? prior!.agent : workers[i % workers.length];
      if (!agent) throw Error("no healthy workers");
      if (!resume)
        this.db.insert("research-attempt", id, {
          id,
          agent,
          contextHash,
          status: "RUNNING",
        });
      try {
        const result = await work(agent, id, feedback);
        fence();
        if (Date.now() >= deadline) throw Error("epoch deadline expired");
        this.db.put("research-attempt", id, {
          id,
          agent,
          contextHash,
          status: "DONE",
          result,
        });
        return result;
      } catch (error) {
        last = error;
        const failure = classifyResearchFailure(error);
        feedback =
          failure === "INVALID_OUTPUT" ? validationFeedback(error) : undefined;
        this.db.put("research-attempt", id, {
          id,
          agent,
          contextHash,
          status: "FAILED",
          failure,
          feedback,
        });
        if (failure === "PLATFORM" || failure === "DATA") throw error;
      }
    }
    throw last;
  }
}
