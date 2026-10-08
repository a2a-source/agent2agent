import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publicAddress,
  validatePublicUrl,
  parseNews,
  parseSearch,
} from "../src/research-tools.js";
test("research URL policy blocks private networks, credentials and non-HTTPS requests", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress("1.1.1.1"), true);
  for (const url of [
    "file:///etc/passwd",
    "http://example.com",
    "https://user:pass@example.com",
    "https://127.1/",
    "https://[::1]/",
  ])
    assert.throws(() => validatePublicUrl(url));
});
test("news/search tools preserve source provenance and publication time", () => {
  const results = parseNews(
    "<rss><channel><item><title>BNB update</title><link>https://example.com/news</link><pubDate>Tue, 06 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>",
  );
  assert.equal(results[0]?.url, "https://example.com/news");
  assert.equal(results[0]?.publishedAt, Date.parse("2026-10-06T00:00:00Z"));
  assert.equal(results[0]?.publishedAtISO, "2026-10-06T00:00:00.000Z");
  assert.equal(
    parseSearch(
      '<a class="result__a" href="https://example.com">Example</a>',
    )[0]?.url,
    "https://example.com/",
  );
});
import { extractPageText } from "../src/research-tools.js";
test("page extraction retains article beyond long navigation before truncating", () => {
  const html =
    "<html><header>" +
    "navigation ".repeat(1500) +
    "</header><main><article><header>October 7</header><p>Official policy rate is 4%.</p></article></main><footer>footer</footer></html>";
  const text = extractPageText(html);
  assert.match(text, /Official policy rate is 4%/);
  assert.match(text, /October 7/);
  assert(!text.includes("navigation"));
  assert.match(
    extractPageText(
      '<div id="content"><div>nested</div><p>release body</p></div><footer>junk</footer>',
    ),
    /release body/,
  );
});
import { assetNewsTool } from "../src/research-tools.js";
import { z } from "zod";
test("batch asset news covers all symbols before spending reasoning rounds on page verification", async () => {
  const queries: string[] = [];
  const tool = assetNewsTool(["BTCB", "ETH", "WBNB"], {
    name: "news_search",
    description: "test",
    schema: z.object({ query: z.string() }),
    run: async ({ query }) => {
      queries.push(query);
      return { data: [], sources: [], missing: ["no results"] };
    },
  });
  const result: any = await tool.run({ lookbackDays: 1 });
  assert.equal(queries.length, 3);
  assert(queries.every((q) => q.endsWith("when:1d")));
  assert.deepEqual(
    result.data.map((r: any) => r.asset),
    ["BTCB", "ETH", "WBNB"],
  );
  assert.equal(result.missing.length, 3);
});
