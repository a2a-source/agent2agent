import { hash } from "./protocol.js";
import { Store } from "./store.js";
export type ResearchFailure =
  "PLATFORM" | "PROVIDER" | "DATA" | "WORKER" | "INVALID_OUTPUT";
export function classifyResearchFailure(error: unknown): ResearchFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof SyntaxError ||
    /validation|fabricated|invalid Master|evidence|Zod/i.test(message) ||
    (error as any)?.name === "ZodError"
  )
    return "INVALID_OUTPUT";
  if (
    /LLM HTTP|fetch|LLM usage|LLM content|provider|uncertain LLM|timeout/i.test(
      message,
    )
  )
    return "PROVIDER";
  if (/ineligible|compute budget/i.test(message)) return "WORKER";
  if (/source|data expired/i.test(message)) return "DATA";
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
}
export interface ResearchOptions {
  concurrency?: number;
  maxAttempts?: number;
}
export class ResearchTasks {
  readonly concurrency: number;
  readonly maxAttempts: number;
  constructor(
    readonly db: Store,
    options: ResearchOptions = {},
  ) {
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
    work: (agent: string, id: string) => Promise<T>,
    context: unknown = key,
  ): Promise<T> {
    const contextHash = hash({ workers, context });
    let last: unknown = Error("research attempts exhausted");
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
      // A crashed dispatch may already have been billed. Never redispatch its identity.
      if (prior) {
        last = Error("prior research attempt unavailable");
        continue;
      }
      const agent = workers[i % workers.length];
      if (!agent) throw Error("no healthy workers");
      this.db.insert("research-attempt", id, {
        id,
        agent,
        contextHash,
        status: "RUNNING",
      });
      try {
        const result = await work(agent, id);
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
        this.db.put("research-attempt", id, {
          id,
          agent,
          contextHash,
          status: "FAILED",
          failure,
        });
        if (failure === "PLATFORM" || failure === "DATA") throw error;
      }
    }
    throw last;
  }
}
