import { hash } from "./protocol.js";
import type { Store } from "./store.js";
import type { ResearchReport } from "./qsp-v2.js";
/** Hash-checked tool facts for synthesis; excerpts are untrusted data, not instructions. */
export function toolEvidenceBrief(
  db: Store,
  proofs: ResearchReport["additionalEvidence"],
) {
  const selected = proofs
    .filter((e) => e.url.startsWith("tool://"))
    .sort((a, b) => {
      const priority = (e: typeof a) => {
        const o = db.get<any>("research-evidence", e.id)?.data;
        return o?.tool === "fetch_page" && typeof o.output?.data === "string"
          ? 0
          : o?.tool === "market_klines"
            ? 1
            : 2;
      };
      return priority(a) - priority(b);
    })
    .slice(0, 8);
  const budget = Math.min(
    2000,
    Math.floor(6000 / Math.max(1, selected.length)),
  );
  return selected.map((e) => {
    const saved = db.get<{ data: unknown }>("research-evidence", e.id);
    if (!saved || hash(saved.data) !== e.contentHash)
      throw Error("tool evidence missing or changed");
    const observed = saved.data as any,
      data = observed?.output?.data,
      candles = data?.candles;
    const display =
      observed?.tool === "market_klines" && Array.isArray(candles)
        ? {
            ...data,
            candleCount: candles.length,
            firstCandle: candles[0],
            candles: candles.slice(-3),
            note: "First and last three closed bars shown; full series retained by evidence hash",
          }
        : data;
    const text = JSON.stringify(display ?? null);
    return {
      evidenceId: e.id,
      contentHash: e.contentHash,
      tool: observed.tool,
      input: observed.input,
      sources: observed.output?.sources ?? [],
      missing: observed.output?.missing ?? [],
      observation: text.slice(0, budget),
      truncated: text.length > budget,
    };
  });
}

/** Require attempts, never fabricate success when a source is unavailable. */
export function validateRoleCoverage(
  role: string,
  c: import("./research-context.js").ResearchContext,
  observations: import("./agent-runtime.js").Observation[],
) {
  const attempted = (name: string) =>
    observations.filter((o) => o.tool === name);
  if (
    role === "market" &&
    c.universe.some(
      (a) =>
        !attempted("market_klines").some(
          (o) => (o.input as any)?.symbol === a.marketSymbol,
        ),
    )
  )
    throw Error("research coverage incomplete: market");
  if (role === "news") {
    const patterns: Record<string, RegExp> = {
      BTCB: /\b(bitcoin|btcb?|btc)\b/i,
      ETH: /\b(ethereum|eth)\b/i,
      WBNB: /\b(bnb|wbnb|binance)\b/i,
    };
    if (
      c.universe.some(
        (a) =>
          patterns[a.symbol] &&
          !attempted("news_search").some((o) =>
            patterns[a.symbol]!.test(String((o.input as any)?.query ?? "")),
          ),
      ) ||
      (attempted("news_search").some(
        (o) => Array.isArray(o.output?.data) && o.output.data.length > 0,
      ) &&
        !attempted("fetch_page").length)
    )
      throw Error("research coverage incomplete: news");
  }
  if (role === "macro" && !attempted("fetch_page").length)
    throw Error("research coverage incomplete: macro");
}
/** Keep referenced sources and tool observations before optional discovery metadata. */
export function retainReportEvidence(
  proofs: ResearchReport["additionalEvidence"],
  references: string[],
) {
  const wanted = new Set(references),
    unique = [...new Map(proofs.map((p) => [p.id, p])).values()];
  const required = unique.filter(
    (p) => wanted.has(p.id) || wanted.has(p.url) || p.url.startsWith("tool://"),
  );
  if (required.length > 64) throw Error("report evidence budget exceeded");
  return [
    ...required,
    ...unique.filter((p) => !required.some((r) => r.id === p.id)),
  ].slice(0, 64);
}
