import { networkFetch as fetch } from "./network.js";
import { Store } from "./store.js";
import { Budget } from "./budget.js";
import { hash } from "./protocol.js";
import { classifyResearchFailure } from "./tasks.js";
import { readJson } from "./http.js";
import type { Config } from "./config.js";
class UnbilledLlmError extends Error {}
export class Llm {
  private readonly apiKeys: string[];
  private keyCursor = 0;
  constructor(
    readonly db: Store,
    readonly budget: Budget,
    readonly config: Config["llm"],
    apiKeys: string | string[],
  ) {
    this.apiKeys = [
      ...new Set(
        (Array.isArray(apiKeys) ? apiKeys : [apiKeys])
          .flatMap((s) => s.split(/\r?\n/))
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#")),
      ),
    ];
  }
  private keyId(key: string) {
    return hash({ endpoint: this.config.endpoint, key });
  }
  private async completion(
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const c = this.config;
    if (!this.apiKeys.length)
      throw new UnbilledLlmError("LLM API key unavailable");
    for (let attempt = 0; attempt < this.apiKeys.length; attempt++) {
      const index = (this.keyCursor + attempt) % this.apiKeys.length,
        key = this.apiKeys[index]!;
      const id = this.keyId(key),
        state = this.db.get<{ retryAt: number }>("llm-key-cooldown", id);
      if (state && Date.now() < state.retryAt) continue;
      const day =
        hash({ endpoint: c.endpoint }) +
        ":" +
        new Date().toISOString().slice(0, 10);
      this.db.transaction(() => {
        const count =
          this.db.get<{ count: number }>("llm-request-count", day)?.count ?? 0;
        if (c.requestLimitPerDay && count >= c.requestLimitPerDay)
          throw new UnbilledLlmError("LLM request limit reached");
        this.db.put("llm-request-count", day, { count: count + 1 });
      });
      const response = await fetch(
        c.endpoint.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.any([
            AbortSignal.timeout(c.timeoutMs),
            ...(signal ? [signal] : []),
          ]),
        },
      );
      if (response.status !== 429) {
        this.keyCursor = index;
        return response;
      }
      const header = response.headers.get("retry-after"),
        seconds = Number(header),
        date = header ? Date.parse(header) : NaN;
      const delay =
        header && Number.isFinite(seconds)
          ? seconds * 1000
          : Number.isFinite(date)
            ? date - Date.now()
            : 60000;
      this.db.put("llm-key-cooldown", id, {
        retryAt: Date.now() + Math.max(1000, Math.min(86400000, delay)),
      });
      await response.body?.cancel();
    }
    throw new UnbilledLlmError("LLM HTTP 429: all keys rate limited");
  }
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
            headers: {
              authorization: `Bearer ${this.apiKeys[this.keyCursor] ?? ""}`,
            },
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
    return this.request(
      agent,
      id,
      {
        messages: [
          { role: "system", content: system },
          { role: "user", content: input },
        ],
        response_format: { type: "json_object" },
      },
      false,
      signal,
    );
  }
  async chat(
    agent: string,
    id: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<any> {
    return this.request(agent, id, request, true, signal);
  }
  private async request(
    agent: string,
    id: string,
    request: Record<string, unknown>,
    raw: boolean,
    signal?: AbortSignal,
  ): Promise<any> {
    const c = this.config;
    const payload = {
      ...request,
      model: c.model,
      max_tokens: c.maxOutputTokens,
      stream: false,
    };
    delete (payload as any).max_completion_tokens;
    if (Buffer.byteLength(JSON.stringify(payload)) > c.maxInputBytes)
      throw Error("LLM input exceeds configured budget");
    const requestHash = hash({ agent, payload, raw, endpoint: c.endpoint });
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
      const response = await this.completion(payload, signal);
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
      // Usage is known even when a provider returns only reasoning or no answer.
      this.budget.settle(id, actual);
      const content = body.choices?.[0]?.message?.content;
      if (
        typeof content !== "string" &&
        !(
          raw &&
          Array.isArray(body.choices?.[0]?.message?.tool_calls) &&
          body.choices[0].message.tool_calls.length
        )
      )
        throw Error("LLM content unavailable");
      // Malformed JSON also retains the already settled usage.
      const result = raw ? body : JSON.parse(content);
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
      if (e instanceof UnbilledLlmError) this.budget.settle(id, 0n);
      else this.budget.unknown(id);
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
