import { structuredOutput } from "./structured-output.js";
import { networkFetch as fetch } from "./network.js";
import { Store } from "./store.js";
import { Budget } from "./budget.js";
import { hash } from "./protocol.js";
import { classifyResearchFailure } from "./tasks.js";
import { readJson } from "./http.js";
import type { Config } from "./config.js";
import {
  quoteCost,
  validateQuote,
  type PriceQuote,
  type PriceSource,
} from "./price.js";
export const REQUEST_USD_MICROS = 10000n;
export class Llm {
  private readonly apiKeys: string[];
  private keyCursor = 0;
  private quoteSnapshot?: PriceQuote;
  private priceRefresh = 0;
  constructor(
    readonly db: Store,
    readonly budget: Budget,
    readonly config: Config["llm"],
    apiKeys: string | string[],
    readonly priceSource?: PriceSource,
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
    agent: string,
    callId: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const c = this.config;
    if (!this.apiKeys.length) throw new Error("LLM API key unavailable");
    for (let attempt = 0; attempt < this.apiKeys.length; attempt++) {
      const index = (this.keyCursor + attempt) % this.apiKeys.length,
        key = this.apiKeys[index]!;
      const id = this.keyId(key),
        state = this.db.get<{ retryAt: number }>("llm-key-cooldown", id);
      if (state && Date.now() < state.retryAt) continue;
      if (signal?.aborted) throw signal.reason;
      const snapshot = this.priceSource
        ? await this.refreshPrice(signal)
        : undefined;
      if (signal?.aborted) throw signal.reason;
      const price = snapshot ? { costWei: quoteCost(snapshot) } : this.price();
      const day =
        hash({ endpoint: c.endpoint }) +
        ":" +
        new Date().toISOString().slice(0, 10);
      const requestId = `${callId}:http:${attempt}`;
      this.db.transaction(() => {
        const count =
          this.db.get<{ count: number }>("llm-request-count", day)?.count ?? 0;
        if (c.requestLimitPerDay && count >= c.requestLimitPerDay)
          throw new Error("LLM request limit reached");
        this.budget.reserve(agent, requestId, price.costWei);
        this.budget.settle(requestId, price.costWei);
        this.db.insert("llm-request", requestId, {
          id: requestId,
          callId,
          agent,
          billing: "fixed-request/1",
          usdMicros: String(REQUEST_USD_MICROS),
          costWei: String(price.costWei),
          priceQuote: snapshot,
          bnbUsdMicros: this.priceSource ? undefined : this.config.bnbUsdMicros,
          keyId: id,
          dispatchedAt: Date.now(),
          state: "DISPATCH_COMMITTED",
        });
        const call = this.db.get<any>("llm-call", callId)!;
        this.db.put("llm-call", callId, {
          ...call,
          cost: String(BigInt(call.cost ?? "0") + price.costWei),
          usdMicros: String(BigInt(call.usdMicros ?? "0") + REQUEST_USD_MICROS),
          requests: (call.requests ?? 0) + 1,
        });
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
    throw new Error("LLM HTTP 429: all keys rate limited");
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
  async refreshPrice(signal?: AbortSignal) {
    if (!this.priceSource) return;
    const refresh = ++this.priceRefresh;
    const bounded = AbortSignal.any([
      AbortSignal.timeout(this.config.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    try {
      const quote = await this.waitForQuote(this.priceSource.quote(), bounded);
      validateQuote(quote, this.priceSource.maxAgeSeconds);
      // Keep a valid snapshot during refresh; only the latest refresh may publish.
      if (refresh === this.priceRefresh) this.quoteSnapshot = quote;
      return quote;
    } catch (error) {
      if (refresh === this.priceRefresh) this.quoteSnapshot = undefined;
      throw error;
    }
  }
  private async waitForQuote(p: Promise<PriceQuote>, signal: AbortSignal) {
    if (signal.aborted) throw Error("BNB/USD oracle unavailable");
    let abort = () => {};
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          abort = () => reject(Error("BNB/USD oracle unavailable"));
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  priceReady() {
    try {
      this.price();
      return true;
    } catch {
      return false;
    }
  }
  private price() {
    if (this.priceSource) {
      if (!this.quoteSnapshot) throw Error("BNB/USD oracle unavailable");
      validateQuote(this.quoteSnapshot, this.priceSource.maxAgeSeconds);
      return { costWei: quoteCost(this.quoteSnapshot) };
    }
    const rate = BigInt(this.config.bnbUsdMicros);
    if (rate <= 0n) throw Error("BNB/USD conversion rate is not configured");
    return {
      costWei: (REQUEST_USD_MICROS * 1000000000000000000n + rate - 1n) / rate,
    };
  }
  maximum() {
    return this.price().costWei * BigInt(Math.max(1, this.apiKeys.length));
  }
  async call(
    agent: string,
    id: string,
    system: string,
    input: string,
    signal?: AbortSignal,
    outputSchema?: Record<string, unknown>,
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
        ...structuredOutput(this.config, outputSchema),
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
      ...(c.reasoningEffort
        ? { reasoning: { effort: c.reasoningEffort } }
        : {}),
    };
    delete (payload as any).max_completion_tokens;
    if (Buffer.byteLength(JSON.stringify(payload)) > c.maxInputBytes)
      throw Error("LLM input exceeds configured budget");
    const requestHash = hash({
      agent,
      payload,
      raw,
      endpoint: c.endpoint,
      billing: "fixed-request/1",
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
      this.db.insert("llm-input", id, { agent, requestHash, payload, raw });
      this.db.insert("llm-call", id, {
        id,
        agent,
        requestHash,
        status: "IN_FLIGHT",
        billing: "fixed-request/1",
        cost: "0",
        usdMicros: "0",
        requests: 0,
        startedAt: Date.now(),
      });
    });
    let diagnostic: Record<string, unknown> | undefined;
    try {
      const response = await this.completion(payload, agent, id, signal);
      if (!response.ok) throw Error(`LLM HTTP ${response.status}`);
      const body = (await readJson(response)) as any;
      // Never persist provider error text, prompts or reasoning in diagnostics.
      const label = (v: unknown) =>
        typeof v === "string" && /^[a-zA-Z0-9_./:-]{1,160}$/.test(v)
          ? v
          : undefined;
      diagnostic = {
        httpStatus: response.status,
        generationId: label(body.id),
        model: label(body.model),
        finishReason: label(body.choices?.[0]?.finish_reason),
        providerErrorCode: Number.isSafeInteger(body.error?.code)
          ? body.error.code
          : undefined,
        hasContent: typeof body.choices?.[0]?.message?.content === "string",
        hasUsage: !!body.usage,
        promptTokens: Number.isSafeInteger(body.usage?.prompt_tokens)
          ? body.usage.prompt_tokens
          : undefined,
        completionTokens: Number.isSafeInteger(body.usage?.completion_tokens)
          ? body.usage.completion_tokens
          : undefined,
        reasoningTokens: Number.isSafeInteger(
          body.usage?.completion_tokens_details?.reasoning_tokens,
        )
          ? body.usage.completion_tokens_details.reasoning_tokens
          : undefined,
      };
      const usage = body.usage;
      const providerError = body.error
        ? new Error(
            `LLM provider error ${diagnostic.providerErrorCode ?? "unknown"}`,
          )
        : undefined;
      if (providerError) throw providerError;
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
      // Every dispatched request was already charged; usage is diagnostics only.
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
        billing: "fixed-request/1",
        cost: this.db.get<any>("llm-call", id)!.cost,
        usdMicros: this.db.get<any>("llm-call", id)!.usdMicros,
        requests: this.db.get<any>("llm-call", id)!.requests,
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

      this.db.put("llm-call", id, {
        id,
        agent,
        requestHash,
        status: "UNKNOWN",
        billing: "fixed-request/1",
        cost: this.db.get<any>("llm-call", id)!.cost,
        usdMicros: this.db.get<any>("llm-call", id)!.usdMicros,
        requests: this.db.get<any>("llm-call", id)!.requests,
        failure,
        error: e instanceof Error ? e.message : "LLM failed",
        diagnostic,
      });
      throw e;
    }
  }
}
