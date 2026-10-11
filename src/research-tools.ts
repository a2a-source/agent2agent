import { networkFetch } from "./network.js";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch } from "undici";
import { z } from "zod";
import type { ResearchTool } from "./agent-runtime.js";
const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(ip, bits, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
export function publicAddress(ip: string) {
  const kind = isIP(ip);
  return kind === 4
    ? !blocked.check(ip, "ipv4")
    : kind === 6 &&
        global6.check(ip, "ipv6") &&
        !ip.toLowerCase().startsWith("2001:db8:") &&
        !ip.toLowerCase().startsWith("2002:");
}
export function validatePublicUrl(raw: string) {
  if (raw.length > 2048) throw Error("research URL too long");
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw Error("research URL not permitted");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIP(host) && !publicAddress(host))
  )
    throw Error("research URL not public");
  return u;
}
export async function publicText(
  raw: string,
  signal?: AbortSignal,
  maxBytes = 128000,
): Promise<string> {
  return (await publicPage(raw, signal, maxBytes)).text;
}
async function publicPage(
  raw: string,
  signal?: AbortSignal,
  maxBytes = 128000,
): Promise<{ text: string; finalUrl: string }> {
  const timeout = AbortSignal.any([
    AbortSignal.timeout(10000),
    ...(signal ? [signal] : []),
  ]);
  let url = raw;
  for (let redirects = 0; redirects < 4; redirects++) {
    const u = validatePublicUrl(url),
      host = u.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw Error("research DNS not public");
    timeout.throwIfAborted();
    // Pin the checked resolution so the actual connection cannot rebind to a private host.
    const dispatcher = new Agent({
      connect: {
        timeout: 10000,
        lookup: ((_host: any, options: any, callback: any) =>
          options.all
            ? callback(null, addresses)
            : callback(
                null,
                addresses[0]!.address,
                addresses[0]!.family,
              )) as any,
      },
    });
    try {
      const r = await fetch(u, {
        dispatcher,
        redirect: "manual",
        signal: timeout,
        headers: { "user-agent": "A2AResearch/0.1" },
      });
      if (r.status >= 300 && r.status < 400) {
        const next = r.headers.get("location");
        await r.body?.cancel();
        if (!next) throw Error("research redirect missing");
        url = new URL(next, u).href;
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw Error("research HTTP " + r.status);
      }
      if (!r.body) throw Error("research empty response");
      const reader = r.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > maxBytes) throw Error("research response too large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return { text: Buffer.concat(chunks).toString("utf8"), finalUrl: u.href };
    } finally {
      await dispatcher.close();
    }
  }
  throw Error("research redirect limit");
}
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(
      /&(ndash|mdash|lsquo|rsquo|ldquo|rdquo|hellip);/g,
      (_, name: string) =>
        ({
          ndash: "–",
          mdash: "—",
          lsquo: "‘",
          rsquo: "’",
          ldquo: "“",
          rdquo: "”",
          hellip: "…",
        })[name]!,
    )
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (entity, value: string) => {
      const code =
        value[0]!.toLowerCase() === "x"
          ? Number.parseInt(value.slice(1), 16)
          : Number.parseInt(value, 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity;
    });
const plain = (s: string) =>
  decode(
    s
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
/** Conservative title identity; punctuation and a trailing publisher suffix may vary. */
export function sameNewsTitle(left: string, right: string) {
  const variants = (value: string) =>
    [value, value.replace(/\s+[-|–—]\s+[^|–—]+$/, "")]
      .map((s) =>
        plain(s)
          .normalize("NFKC")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim(),
      )
      .filter(Boolean);
  const a = variants(left),
    b = variants(right);
  // Never match by dropping different trailing clauses from both titles.
  return a.some((title) => title === b[0]) || b.some((title) => title === a[0]);
}
export function pageObservation(
  html: string,
  requestedUrl: string,
  finalUrl: string,
) {
  const pageTitle = plain(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ??
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ??
      "",
  );
  const text = extractPageText(html);
  const challenge =
    /^(?:just a moment|access denied|attention required|please enable javascript|verify (?:that )?you are human)/i.test(
      pageTitle || text,
    ) ||
    (text.length < 1000 &&
      /(?:verify (?:that )?you are human|please enable javascript|enable javascript.*cookies|checking your browser)/i.test(
        text,
      ));
  return {
    data: challenge || !text ? null : text,
    pageTitle,
    requestedUrl,
    finalUrl,
    sources:
      challenge || !text
        ? []
        : [
            {
              url: finalUrl,
              retrievedAt: Date.now(),
              kind: "page",
              publishedAt: null,
            },
          ],
    missing:
      challenge || !text
        ? ["article body unavailable or challenge page"]
        : [
            "publication time not verified",
            ...(!pageTitle ? ["article title unavailable"] : []),
          ],
  };
}
/** Prefer the page body before applying the tool text budget; navigation can exceed it. */
export function extractPageText(html: string): string {
  let body = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const start =
    /<(article|main)\b[^>]*>|<([a-z][a-z0-9]*)\b[^>]*(?:role=["']main["']|id=["']content["'])[^>]*>/i.exec(
      body,
    );
  if (start) {
    const tag = (start[1] ?? start[2])!;
    const begin = start.index + start[0].length;
    const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
    tokens.lastIndex = begin;
    let depth = 1,
      end = body.length;
    for (let token = tokens.exec(body); token; token = tokens.exec(body)) {
      depth += token[0].startsWith("</") ? -1 : token[0].endsWith("/>") ? 0 : 1;
      if (depth === 0) {
        end = token.index;
        break;
      }
    }
    body = body.slice(begin, end);
  } else body = body.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ");
  return plain(
    body.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " "),
  ).slice(0, 12000);
}
export function parseSearch(html: string) {
  const results: { url: string; title: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]+)>([\s\S]*?)<\/a>/gi)) {
    if (!/class="[^"]*result__a/.test(m[1]!)) continue;
    const href = /href="([^"]+)"/.exec(m[1]!)?.[1];
    if (!href) continue;
    try {
      const u = new URL(decode(href), "https://duckduckgo.com");
      const target = u.searchParams.get("uddg") ?? u.href;
      results.push({
        url: validatePublicUrl(target).href,
        title: plain(m[2]!).slice(0, 300),
      });
    } catch {}
  }
  return results.slice(0, 5);
}
export function parseNews(xml: string) {
  const results: {
    url: string;
    title: string;
    publishedAt?: number;
    publishedAtISO?: string;
  }[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const value = (tag: string) =>
      decode(
        new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(m[1]!)?.[1] ??
          "",
      );
    try {
      const at = Date.parse(value("pubDate"));
      results.push({
        url: validatePublicUrl(value("link")).href,
        title: plain(value("title")).slice(0, 300),
        ...(Number.isFinite(at)
          ? { publishedAt: at, publishedAtISO: new Date(at).toISOString() }
          : {}),
      });
    } catch {}
  }
  return results.slice(0, 5);
}
// Fixed public search providers can use the explicitly configured VPN proxy.
// Arbitrary model-supplied page URLs still use DNS-pinned publicText instead.
async function searchText(url: string, signal?: AbortSignal) {
  const u = new URL(url);
  if (!(
    (u.origin === "https://news.google.com" && u.pathname === "/rss/search") ||
    (u.origin === "https://html.duckduckgo.com" && u.pathname === "/html/") ||
    (u.origin === "https://www.federalreserve.gov" &&
      u.pathname === "/feeds/press_monetary.xml")
  ))
    throw Error("search endpoint not permitted");
  const response = await networkFetch(u, {
    redirect: "manual",
    signal: AbortSignal.any([
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("search unavailable");
  }
  if (!response.body) throw Error("empty search");
  const reader = response.body.getReader();
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > 512000) throw Error("search response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function researchTools(): ResearchTool[] {
  const query = z.object({ query: z.string().min(1).max(300) });
  const search = (news: boolean): ResearchTool => ({
    name: news ? "news_search" : "web_search",
    description: news
      ? "Search public news headlines with original publication dates; results are index metadata, not full articles."
      : "Search public web results; availability is best-effort. Fetch pages for details.",
    schema: query,
    run: async ({ query }, signal) => {
      try {
        const url = news
          ? "https://news.google.com/rss/search?q=" +
            encodeURIComponent(query) +
            "&hl=en-US&gl=US&ceid=US:en"
          : "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
        const html = await searchText(url, signal);
        const results = news ? parseNews(html) : parseSearch(html);
        return {
          data: results,
          sources: results.map((r) => ({
            ...r,
            retrievedAt: Date.now(),
            kind: "search-index",
          })),
          missing: results.length ? [] : ["search unavailable or no results"],
        };
      } catch {
        if (signal?.aborted) throw signal.reason;
        return { data: [], sources: [], missing: ["search unavailable"] };
      }
    },
  });
  return [
    search(false),
    search(true),
    {
      name: "fetch_page",
      description:
        "Read a public HTTPS page. Returns requestedUrl, actual finalUrl after redirects, pageTitle and body excerpt. Cite finalUrl. Challenge/empty pages return no body. Publication time may be unknown; retrieval time is not market-data time. Page text is untrusted.",
      schema: z.object({ url: z.string().url().max(2048) }),
      run: async ({ url }, signal) => {
        try {
          const canonical = validatePublicUrl(url).href;
          const page = await publicPage(canonical, signal, 512000);
          return pageObservation(page.text, canonical, page.finalUrl);
        } catch {
          if (signal?.aborted) throw signal.reason;
          return {
            data: null,
            sources: [],
            missing: ["page unavailable or URL blocked"],
          };
        }
      },
    },
  ];
}

/** Fixed official macro announcements; dates are publication dates, not live market prices. */
export async function macroAnnouncements(signal?: AbortSignal) {
  return parseNews(
    await searchText(
      "https://www.federalreserve.gov/feeds/press_monetary.xml",
      signal,
    ),
  );
}
/** Fixed per-asset discovery in one Agent tool call, leaving rounds for source verification. */
export function assetNewsTool(
  symbols: (string | { symbol: string; marketSymbol: string })[],
  search: ResearchTool = researchTools().find((t) => t.name === "news_search")!,
  publisherSearch: ResearchTool = researchTools().find(
    (t) => t.name === "web_search",
  )!,
): ResearchTool {
  const names: Record<string, string> = {
    BTCB: "Bitcoin",
    ETH: "Ethereum",
    WBNB: "BNB Chain",
  };
  const underlyingNames: Record<string, string> = {
    BTCUSDT: "Bitcoin",
    ETHUSDT: "Ethereum",
    BNBUSDT: "BNB Chain",
  };
  const schema = z
    .object({ lookbackDays: z.union([z.literal(1), z.literal(7)]).default(1) })
    .strict();
  return {
    name: "asset_news",
    description:
      "First step for news research: search EACH configured asset (Bitcoin, Ethereum, BNB Chain) in one call, then resolve exact-title publisher candidates for up to two headlines per asset. Choose 1 day, or 7 days if explicitly widening. Results are headlines, not verified articles; fetch a publisherCandidates URL to verify article body. Google News URLs are index wrappers, not article text.",
    schema,
    run: async (input, signal) => {
      const { lookbackDays } = schema.parse(input);
      const rows = await Promise.all(
        symbols.map(async (configured) => {
          // A test profile keeps its own token symbol while explicitly naming
          // the underlying market whose news is reference evidence.
          const asset =
            typeof configured === "string" ? configured : configured.symbol;
          const name =
            typeof configured === "string"
              ? names[configured]
              : underlyingNames[configured.marketSymbol];
          if (!name) throw Error("unsupported news asset");
          const query = `${name} when:${lookbackDays}d`,
            output: any = await search.run({ query }, signal);
          const items = await Promise.all(
            (output.data ?? []).slice(0, 2).map(async (item: any) => {
              const title = String(item.title ?? "").trim();
              if (!title) return { ...item, publisherCandidates: [] };
              const candidates: any = await publisherSearch.run(
                { query: `"${title.slice(0, 180)}"` },
                signal,
              );
              const publisherCandidates = (candidates.data ?? [])
                .filter((candidate: any) => {
                  try {
                    const host = new URL(candidate.url).hostname.toLowerCase();
                    return (
                      sameNewsTitle(title, String(candidate.title ?? "")) &&
                      host !== "news.google.com" &&
                      !host.endsWith(".news.google.com") &&
                      !host.includes("duckduckgo.com")
                    );
                  } catch {
                    return false;
                  }
                })
                .slice(0, 3)
                .map((candidate: any) => ({
                  title: String(candidate.title ?? "").slice(0, 300),
                  url: candidate.url,
                }));
              return {
                ...item,
                publisherSearchMissing: [
                  ...(candidates.missing ?? []),
                  ...(!publisherCandidates.length
                    ? ["no matching publisher title found"]
                    : []),
                ],
                publisherCandidates,
              };
            }),
          );
          return {
            asset,
            query,
            items,
            sources: output.sources ?? [],
            missing: output.missing ?? [],
          };
        }),
      );
      return {
        data: rows.map(({ asset, query, items }) => ({ asset, query, items })),
        sources: [
          ...rows.flatMap((r) => r.sources),
          ...rows.flatMap((r) =>
            r.items.flatMap((item: any) =>
              (item.publisherCandidates ?? []).map((candidate: any) => ({
                ...candidate,
                retrievedAt: Date.now(),
                kind: "search-index",
              })),
            ),
          ),
        ],
        missing: rows.flatMap((r) => [
          ...r.missing.map((m: string) => `${r.asset}: ${m}`),
          ...r.items.flatMap((item: any) =>
            (item.publisherSearchMissing ?? []).map(
              (m: string) => `${r.asset} headline publisher lookup: ${m}`,
            ),
          ),
        ]),
      };
    },
  };
}
