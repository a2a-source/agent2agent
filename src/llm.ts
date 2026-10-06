import { networkFetch as fetch } from "./network.js";
import { Store } from "./store.js";
import { Budget } from "./budget.js";
import { hash } from "./protocol.js";
import { classifyResearchFailure } from "./tasks.js";
import { readJson } from "./http.js";
import type { Config } from "./config.js";
export class Llm {
  constructor(
    readonly db: Store,
    readonly budget: Budget,
    readonly config: Config["llm"],
    private apiKey: string,
  ) {}
  private probing?: Promise<boolean>;
  private providerKey() {
    return hash({ endpoint: this.config.endpoint, model: this.config.model });
  }
  private async waitForProbe(probe: Promise<boolean>, signal?: AbortSignal) {
    if (!signal) return probe;
    if (signal.aborted) throw signal.reason;
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([probe, aborted]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async probeProvider(
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<boolean> {
    const state = this.db.get<{ failures: number; retryAt: number }>(
      "provider-circuit",
      this.providerKey(),
    );
    if (!state || state.failures < 2) return true;
    if (now < state.retryAt) return false;
    if (this.probing) return this.waitForProbe(this.probing, signal);
    this.probing = (async () => {
      try {
        const response = await fetch(
          this.config.endpoint.replace(/\/$/, "") + "/models",
          {
            headers: { authorization: `Bearer ${this.apiKey}` },
            signal: AbortSignal.any([
              AbortSignal.timeout(this.config.timeoutMs),
              ...(signal ? [signal] : []),
            ]),
          },
        );
        // Compatible providers need not implement model discovery. A bounded
        // next paid task is the half-open probe when discovery is unsupported.
        if (response.status === 404 || response.status === 405) {
          await response.body?.cancel();
          this.db.put("provider-circuit", this.providerKey(), {
            failures: 1,
            retryAt: 0,
          });
          return true;
        }
        if (!response.ok) throw Error("provider probe rejected");
        await response.body?.cancel();
        this.db.put("provider-circuit", this.providerKey(), {
          failures: 0,
          retryAt: 0,
        });
        return true;
      } catch {
        if (signal?.aborted) return false;
        this.db.put("provider-circuit", this.providerKey(), {
          failures: state.failures,
          retryAt: Date.now() + Math.min(60000, this.config.timeoutMs),
        });
        return false;
      } finally {
        this.probing = undefined;
      }
    })();
    return this.waitForProbe(this.probing, signal);
  }
  maximum() {
    const c = this.config;
    return (
      (BigInt(c.maxInputBytes + 512) * BigInt(c.inputWeiPerMillion) +
        BigInt(c.maxOutputTokens) * BigInt(c.outputWeiPerMillion) +
        999999n) /
      1000000n
    );
  }
  async call(
    agent: string,
    id: string,
    system: string,
    input: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const c = this.config;
    if (Buffer.byteLength(system + input) > c.maxInputBytes)
      throw Error("LLM input exceeds configured budget");
    const requestHash = hash({
      agent,
      system,
      input,
      model: c.model,
      endpoint: c.endpoint,
      maxOutputTokens: c.maxOutputTokens,
    });
    const cached = this.db.get<any>("llm-call", id);
    if (cached) {
      if (cached.requestHash !== requestHash)
        throw Error("LLM request conflict");
      if (cached.status === "DONE") return cached.result;
      throw Error("uncertain LLM call requires reconciliation");
    }
    if (signal?.aborted) throw signal.reason;
    const providerReady = await this.probeProvider(Date.now(), signal);
    if (signal?.aborted) throw signal.reason;
    if (!providerReady) throw Error("provider circuit open");
    this.db.transaction(() => {
      this.budget.reserve(agent, id, this.maximum());
      this.db.insert("llm-call", id, {
        id,
        agent,
        requestHash,
        status: "IN_FLIGHT",
        startedAt: Date.now(),
      });
    });
    try {
      const response = await fetch(
        c.endpoint.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: c.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: input },
            ],
            max_tokens: c.maxOutputTokens,
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.any([
            AbortSignal.timeout(c.timeoutMs),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      if (!response.ok) throw Error(`LLM HTTP ${response.status}`);
      const body = (await readJson(response)) as any;
      const usage = body.usage;
      if (
        !Number.isSafeInteger(usage?.prompt_tokens) ||
        !Number.isSafeInteger(usage?.completion_tokens) ||
        usage.prompt_tokens < 0 ||
        usage.completion_tokens < 0
      )
        throw Error("LLM usage unavailable");
      const actual =
        (BigInt(usage.prompt_tokens) * BigInt(c.inputWeiPerMillion) +
          BigInt(usage.completion_tokens) * BigInt(c.outputWeiPerMillion) +
          999999n) /
        1000000n;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw Error("LLM content unavailable");
      // Known billed usage is settled even if the model returned malformed JSON.
      this.budget.settle(id, actual);
      const result = JSON.parse(content);
      this.db.put("provider-circuit", this.providerKey(), {
        failures: 0,
        retryAt: 0,
      });
      this.db.put("llm-call", id, {
        id,
        agent,
        requestHash,
        status: "DONE",
        result,
        usage,
        cost: String(actual),
      });
      return result;
    } catch (e) {
      const failure = classifyResearchFailure(e);
      if (failure === "PROVIDER") {
        const prior = this.db.get<{ failures: number }>(
          "provider-circuit",
          this.providerKey(),
        );
        const failures = (prior?.failures ?? 0) + 1;
        this.db.put("provider-circuit", this.providerKey(), {
          failures,
          retryAt: Date.now() + Math.min(60000, c.timeoutMs),
        });
      }
      this.budget.unknown(id);
      this.db.put("llm-call", id, {
        id,
        agent,
        requestHash,
        status: "UNKNOWN",
        failure,
        error: e instanceof Error ? e.message : "LLM failed",
      });
      throw e;
    }
  }
}
