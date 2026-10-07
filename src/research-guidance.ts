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
