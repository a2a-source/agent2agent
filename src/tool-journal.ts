import { Store } from "./store.js";
import { hash } from "./protocol.js";
export interface ToolCall {
  agent: string;
  runId: string;
  sequence: number;
  tool: string;
  input: unknown;
}
type Status = "RUNNING" | "DONE" | "FAILED" | "ABORTED" | "REJECTED";
interface CallRecord extends ToolCall {
  fingerprint: string;
  status: Status;
  dispatched: boolean;
  startedAt: number | null;
  finishedAt?: number;
  reason?: "TOOL_LIMIT" | "TOOL_FAILURE" | "ABORTED";
}
export class ToolJournal {
  constructor(readonly db: Store) {}
  async run(
    call: ToolCall,
    execute: () => Promise<unknown>,
    signal?: AbortSignal,
    rejection?: "TOOL_LIMIT",
  ): Promise<unknown> {
    const key = `${call.runId}:tool:${call.sequence}`;
    const fingerprint = hash({ name: call.tool, args: call.input });
    const prior = this.db.get<CallRecord>("agent-tool-call", key);
    const cached = this.db.get<{ fingerprint: string; output: unknown }>(
      "agent-tool",
      key,
    );
    if (
      (prior &&
        (prior.fingerprint !== fingerprint || prior.agent !== call.agent)) ||
      (cached && cached.fingerprint !== fingerprint)
    )
      throw Error("Agent tool request conflict");
    if (prior && prior.status !== "DONE") {
      if (prior.status === "RUNNING")
        throw Error(
          "uncertain Agent tool call; retry through a new research attempt",
        );
      throw this.failure(prior.status);
    }
    if (cached) return cached.output;
    if (prior) throw Error("Agent tool completed result missing");
    const status: Status = signal?.aborted
      ? "ABORTED"
      : rejection
        ? "REJECTED"
        : "RUNNING";
    const row: CallRecord = {
      ...call,
      fingerprint,
      status,
      dispatched: status === "RUNNING",
      startedAt: status === "RUNNING" ? Date.now() : null,
      ...(status !== "RUNNING"
        ? {
            finishedAt: Date.now(),
            reason: signal?.aborted ? ("ABORTED" as const) : rejection,
          }
        : {}),
    };
    // Commit before external IO; a crash leaves RUNNING, never permission to replay.
    this.db.insert("agent-tool-call", key, row);
    if (status !== "RUNNING") throw this.failure(status);
    let output: unknown;
    try {
      output = await execute();
      if (signal?.aborted) throw Error("aborted");
      // Validate serialization before marking success; callers see the same value on replay.
      output = JSON.parse(JSON.stringify(output));
    } catch {
      const aborted = !!signal?.aborted;
      this.db.put("agent-tool-call", key, {
        ...row,
        status: aborted ? "ABORTED" : "FAILED",
        finishedAt: Date.now(),
        reason: aborted ? "ABORTED" : "TOOL_FAILURE",
      });
      // Do not persist or propagate arbitrary provider errors containing credentials.
      throw this.failure(aborted ? "ABORTED" : "FAILED");
    }
    this.db.transaction(() => {
      this.db.insert("agent-tool", key, {
        fingerprint,
        tool: call.tool,
        input: call.input,
        output,
      });
      this.db.put("agent-tool-call", key, {
        ...row,
        status: "DONE",
        finishedAt: Date.now(),
      });
    });
    return output;
  }
  private failure(status: Status) {
    return Error(
      status === "ABORTED"
        ? "Agent tool aborted"
        : status === "REJECTED"
          ? "Agent tool call limit exceeded"
          : "Agent tool failed",
    );
  }
}
