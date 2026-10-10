import { hash } from "./protocol.js";
import type { Store } from "./store.js";
import type { ResearchReport } from "./qsp-v2.js";
import { sameNewsTitle } from "./research-tools.js";
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
          !attempted("asset_news").some(
            (o) =>
              Array.isArray(o.output?.data) &&
              o.output.data.some((row: any) => row.asset === a.symbol),
          ) &&
          !attempted("news_search").some(
            (o) =>
              newsQueryAssets(String((o.input as any)?.query ?? "")).join(
                ",",
              ) === a.symbol,
          ),
      ) ||
      ([...attempted("news_search"), ...attempted("asset_news")].some(
        (o) =>
          Array.isArray(o.output?.data) &&
          (o.tool === "asset_news"
            ? o.output.data.some((r: any) => r.items?.length > 0)
            : o.output.data.length > 0),
      ) &&
        !hasNewsPublisherCoverage(observations))
    )
      throw Error("research coverage incomplete: news");
  }
  if (role === "macro" && !attempted("fetch_page").length)
    throw Error("research coverage incomplete: macro");
}

/** Each discovered publisher is attempted; index wrappers never count. */
function hasNewsPublisherCoverage(
  observations: import("./agent-runtime.js").Observation[],
) {
  const groups: Set<string>[] = [];
  for (const observation of observations) {
    if (
      observation.tool === "asset_news" &&
      Array.isArray(observation.output?.data)
    )
      for (const row of observation.output.data as any[]) {
        const urls = new Set<string>(
          (row.items ?? [])
            .flatMap((item: any) => item.publisherCandidates ?? [])
            .map((candidate: any) => canonicalNewsUrl(candidate.url))
            .filter(isPublisherUrl),
        );
        if (urls.size) groups.push(urls);
      }
    if (
      observation.tool === "news_search" &&
      Array.isArray(observation.output?.data)
    ) {
      const urls = new Set<string>(
        (observation.output.data as any[])
          .map((item) => canonicalNewsUrl(item.url))
          .filter(isPublisherUrl),
      );
      if (urls.size) {
        if (
          newsQueryAssets(String((observation.input as any)?.query ?? ""))
            .length !== 1
        )
          return false;
        groups.push(urls);
      }
    }
  }
  const attempts = new Set(
    observations
      .filter((o) => o.tool === "fetch_page")
      .map((o) => canonicalNewsUrl(String((o.input as any)?.url ?? "")))
      .filter(isPublisherUrl),
  );
  // No publisher URL was found, so the role can accurately report HEADLINE_ONLY.
  return groups.every((urls) => [...urls].some((url) => attempts.has(url)));
}

function newsQueryAssets(query: string) {
  return [
    ...(/\b(bitcoin|btcb?|btc)\b/i.test(query) ? ["BTCB"] : []),
    ...(/\b(ethereum|eth)\b/i.test(query) ? ["ETH"] : []),
    ...(/\b(bnb|wbnb|binance)\b/i.test(query) ? ["WBNB"] : []),
  ];
}

function isPublisherUrl(value: string) {
  if (!value) return false;
  try {
    const url = new URL(value),
      host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      host !== "news.google.com" &&
      !host.endsWith(".news.google.com") &&
      host !== "duckduckgo.com" &&
      !host.endsWith(".duckduckgo.com")
    );
  } catch {
    return false;
  }
}

/** Reject a FULL_TEXT label unless a nonempty publisher body was observed. */
export function validateNewsBodyClaims(
  role: string,
  report: Pick<ResearchReport, "summary" | "recommendation" | "sections">,
  observations: import("./agent-runtime.js").Observation[],
) {
  if (role !== "news") return;
  const section =
    report.sections?.find((row) => row.id === "asset_news") ??
    report.sections?.[0];
  if (!section) return;
  const candidates = new Map<string, Set<string>>();
  const headlines: { asset: string; title: string }[] = [];
  const candidateKey = (asset: string, headline: string) =>
    `${asset}:${normalizeNewsHeadline(headline)}`;
  const addCandidate = (asset: string, headline: string, url: string) => {
    const canonical = canonicalNewsUrl(url);
    if (!isPublisherUrl(canonical)) return;
    const key = candidateKey(asset, headline),
      values = candidates.get(key) ?? new Set<string>();
    values.add(canonical);
    candidates.set(key, values);
  };
  for (const observation of observations) {
    if (
      observation.tool === "asset_news" &&
      Array.isArray(observation.output?.data)
    )
      for (const row of observation.output.data as any[])
        for (const item of row.items ?? []) {
          headlines.push({ asset: row.asset, title: String(item.title ?? "") });
          for (const candidate of item.publisherCandidates ?? [])
            addCandidate(row.asset, String(item.title ?? ""), candidate.url);
        }
    if (
      observation.tool === "news_search" &&
      Array.isArray(observation.output?.data)
    ) {
      const query = String((observation.input as any)?.query ?? "");
      const assets = newsQueryAssets(query);
      for (const item of observation.output.data as any[])
        if (assets.length === 1) {
          headlines.push({
            asset: assets[0]!,
            title: String(item.title ?? ""),
          });
          addCandidate(assets[0]!, String(item.title ?? ""), item.url);
        }
    }
  }
  // A manual exact-title follow-up remains associated with its discovered item.
  for (const observation of observations) {
    if (
      observation.tool !== "web_search" ||
      !Array.isArray(observation.output?.data)
    )
      continue;
    const query = String((observation.input as any)?.query ?? "")
      .trim()
      .replace(/^"(.*)"$/, "$1");
    for (const item of headlines.filter(
      (h) => normalizeNewsHeadline(h.title) === normalizeNewsHeadline(query),
    ))
      for (const result of observation.output.data)
        if (sameNewsTitle(item.title, String(result.title ?? "")))
          addCandidate(item.asset, item.title, result.url);
  }

  for (const line of section.content.split(/\r?\n/)) {
    const row =
      /^\s*(?:[-*]\s*)?asset=(BTCB|ETH|WBNB);\s*status=(FULL_TEXT|HEADLINE_ONLY)\s*;\s*headline=(.+?);\s*publishedAt=[^;]+;\s*publisherUrl=(https?:\/\/[^\s;]+);\s*relevance=.+$/i.exec(
        line,
      );
    if (!row) {
      if (/\bstatus\s*=\s*FULL_TEXT\b/i.test(line))
        throw Error("news FULL_TEXT claim lacks a source-bound asset row");
      continue;
    }
    // The status field is authoritative; titles and commentary are not statuses.
    if (row[2]!.toUpperCase() === "FULL_TEXT") {
      if (!row[3]!.trim())
        throw Error("news FULL_TEXT claim lacks a source-bound asset row");
      const asset = row[1]!.toUpperCase(),
        headline = row[3]!.trim(),
        url = canonicalNewsUrl(row[4]!);
      if (!isPublisherUrl(url) || !section.evidenceRefs.includes(url))
        throw Error("news FULL_TEXT claim lacks matching article evidence");
      const fetched = observations.some((observation) => {
        if (
          observation.tool !== "fetch_page" ||
          typeof observation.output?.data !== "string" ||
          !observation.output.data.trim() ||
          !sameNewsTitle(headline, String(observation.output.pageTitle ?? ""))
        )
          return false;
        const requested = canonicalNewsUrl(
          String((observation.input as any)?.url ?? ""),
        );
        return (
          candidates.get(candidateKey(asset, headline))?.has(requested) &&
          canonicalNewsUrl(String(observation.output.finalUrl ?? "")) === url &&
          (observation.output.sources ?? []).some(
            (source: any) => canonicalNewsUrl(source.url) === url,
          )
        );
      });
      if (!fetched)
        throw Error("news FULL_TEXT claim lacks matching article evidence");
    }
  }

  const otherSections = [
    report.summary,
    report.recommendation,
    ...(report.sections ?? [])
      .filter((row) => row.id !== section.id)
      .map((row) => row.content),
  ].join("\n");
  if (/\bstatus\s*=\s*FULL_TEXT\b/i.test(otherSections))
    throw Error("news FULL_TEXT claim lacks a source-bound asset row");
}

function normalizeNewsHeadline(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function canonicalNewsUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
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
