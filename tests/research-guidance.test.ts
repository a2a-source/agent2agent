import { test } from "node:test";
import assert from "node:assert/strict";
import { toolEvidenceBrief } from "../src/research-guidance.js";
import { evidence, normalizeEvidence } from "../src/research-context.js";
import { Store } from "../src/store.js";
import { hash } from "../src/protocol.js";
test("Master receives hash-bound tool facts and missing results, never unbounded output", () => {
  const db = new Store(":memory:");
  try {
    const observation = {
      tool: "fetch_page",
      input: { url: "https://example.com" },
      output: {
        data: "x".repeat(10000),
        sources: [{ url: "https://example.com" }],
        missing: ["publication time unknown"],
      },
    };
    const e = evidence("web", "tool://fetch_page", null, observation);
    db.put("research-evidence", e.id, {
      ...e,
      data: normalizeEvidence(observation),
    });
    const b = toolEvidenceBrief(db, [e]);
    assert.equal(b.length, 1);
    assert.equal(b[0]!.evidenceId, e.id);
    assert.equal(b[0]!.contentHash, hash(normalizeEvidence(observation)));
    assert(b[0]!.observation.length < 6000);
    assert(b[0]!.truncated);
    assert.deepEqual(b[0]!.missing, ["publication time unknown"]);
    assert.equal(b[0]!.sources[0].url, "https://example.com");
    const many = toolEvidenceBrief(
      db,
      Array.from({ length: 8 }, () => e),
    );
    assert(many.every((x) => x.observation.length > 0));
    assert(many.reduce((n, x) => n + x.observation.length, 0) <= 6000);
    db.put("research-evidence", e.id, { ...e, data: { tampered: true } });
    assert.throws(() => toolEvidenceBrief(db, [e]), /evidence/);
  } finally {
    db.close();
  }
});
import {
  validateNewsBodyClaims,
  validateRoleCoverage,
} from "../src/research-guidance.js";
test("role coverage rejects premature news or trend completion but accepts attempted missing data", () => {
  const c: any = {
    universe: [
      { symbol: "BTCB", marketSymbol: "BTCUSDT" },
      { symbol: "ETH", marketSymbol: "ETHUSDT" },
      { symbol: "WBNB", marketSymbol: "BNBUSDT" },
    ],
  };
  const observation = (tool: string, input: any) => ({
    tool,
    input,
    output: { data: null, missing: ["unavailable"] },
  });
  assert.throws(
    () =>
      validateRoleCoverage("news", c, [
        observation("news_search", { query: "Bitcoin when:1d" }),
      ]),
    /coverage/,
  );
  const news = ["Bitcoin", "Ethereum", "BNB Chain"].map((query) => ({
    tool: "news_search",
    input: { query },
    output: {
      data: [{ title: "Update", url: "https://publisher.example/story" }],
      missing: [],
    },
  }));
  assert.throws(
    () =>
      validateRoleCoverage("news", c, [
        ...news,
        {
          tool: "fetch_page",
          input: { url: "https://news.google.com/rss/articles/id" },
          output: {
            data: "index wrapper",
            sources: [{ url: "https://news.google.com/rss/articles/id" }],
          },
        },
      ]),
    /coverage/,
  );
  validateRoleCoverage("news", c, [
    ...news,
    {
      tool: "fetch_page",
      input: { url: "https://publisher.example/story" },
      output: {
        data: "Article body",
        sources: [{ url: "https://publisher.example/story" }],
      },
    },
  ]);
  const failedPublisherFetch = {
    tool: "fetch_page",
    input: { url: "https://publisher.example/story" },
    output: { data: null, sources: [], missing: ["page unavailable"] },
  };
  validateRoleCoverage("news", c, [...news, failedPublisherFetch]);
  validateNewsBodyClaims(
    "news",
    {
      summary: "Observed headline only",
      recommendation: "Observe",
      sections: [
        {
          id: "asset_news",
          content:
            "asset=BTCB; status=HEADLINE_ONLY; headline=Update; publishedAt=unknown; publisherUrl=https://publisher.example/story; relevance=unverified",
          evidenceRefs: ["https://publisher.example/story"],
        },
      ],
    },
    [...news, failedPublisherFetch] as any,
  );
  const articleBody = {
    tool: "fetch_page",
    input: { url: "https://publisher.example/story" },
    output: {
      data: "Verified publisher article body",
      pageTitle: "Update",
      finalUrl: "https://publisher.example/story",
      sources: [{ url: "https://publisher.example/story" }],
    },
  };
  validateNewsBodyClaims(
    "news",
    {
      summary: "Verified publisher article",
      recommendation: "Consider context",
      sections: [
        {
          id: "asset_news",
          content:
            "asset=BTCB; status=FULL_TEXT; headline=Update; publishedAt=unknown; publisherUrl=https://publisher.example/story; relevance=verified",
          evidenceRefs: ["https://publisher.example/story"],
        },
      ],
    },
    [...news, articleBody] as any,
  );
  const multiAssetDiscovery = {
    tool: "asset_news",
    input: { lookbackDays: 1 },
    output: {
      data: ["BTCB", "ETH", "WBNB"].map((asset) => ({
        asset,
        items: [
          {
            title: `${asset} Update`,
            publisherCandidates: [
              { url: `https://${asset.toLowerCase()}.example/story` },
            ],
          },
        ],
      })),
    },
  };
  assert.throws(
    () =>
      validateNewsBodyClaims(
        "news",
        {
          summary: "Two reports claim verified body coverage",
          recommendation: "Observe",
          sections: [
            {
              id: "asset_news",
              content: ["BTCB", "ETH"]
                .map(
                  (asset) =>
                    `asset=${asset}; status=FULL_TEXT; headline=${asset} Update; publishedAt=unknown; publisherUrl=https://${asset.toLowerCase()}.example/story; relevance=verified`,
                )
                .join("\n"),
              evidenceRefs: [
                "https://btcb.example/story",
                "https://eth.example/story",
              ],
            },
          ],
        },
        [
          multiAssetDiscovery,
          {
            tool: "fetch_page",
            input: { url: "https://btcb.example/story" },
            output: {
              data: "BTCB publisher body",
              sources: [{ url: "https://btcb.example/story" }],
            },
          },
        ] as any,
      ),
    /matching article evidence/,
  );
  const sameAssetDiscovery = {
    tool: "asset_news",
    input: { lookbackDays: 1 },
    output: {
      data: [
        {
          asset: "BTCB",
          items: [
            {
              title: "Story A",
              publisherCandidates: [{ url: "https://publisher.example/a" }],
            },
            {
              title: "Story B",
              publisherCandidates: [{ url: "https://publisher.example/b" }],
            },
          ],
        },
      ],
    },
  };
  assert.throws(
    () =>
      validateNewsBodyClaims(
        "news",
        {
          summary: "Two stories reported",
          recommendation: "Observe",
          sections: [
            {
              id: "asset_news",
              content: [
                "asset=BTCB; status=FULL_TEXT; headline=Story A; publishedAt=unknown; publisherUrl=https://publisher.example/a; relevance=verified",
                "asset=BTCB; status=FULL_TEXT; headline=Story B; publishedAt=unknown; publisherUrl=https://publisher.example/b; relevance=verified",
              ].join("\n"),
              evidenceRefs: [
                "https://publisher.example/a",
                "https://publisher.example/b",
              ],
            },
          ],
        },
        [
          sameAssetDiscovery,
          {
            tool: "fetch_page",
            input: { url: "https://publisher.example/a" },
            output: {
              data: "Story A body",
              sources: [{ url: "https://publisher.example/a" }],
            },
          },
        ] as any,
      ),
    /matching article evidence/,
  );
  assert.throws(
    () =>
      validateNewsBodyClaims(
        "news",
        {
          summary: "Only a headline is available",
          recommendation: "Observe",
          sections: [
            {
              id: "asset_news",
              content:
                "asset=BTCB; status=FULL_TEXT; headline=Update; publishedAt=unknown; publisherUrl=https://publisher.example/story; relevance=verified",
              evidenceRefs: ["https://publisher.example/story"],
            },
          ],
        },
        [...news, failedPublisherFetch] as any,
      ),
    /matching article evidence/,
  );
  assert.throws(
    () =>
      validateNewsBodyClaims(
        "news",
        {
          summary: "Unrelated body fetched",
          recommendation: "Observe",
          sections: [
            {
              id: "asset_news",
              content:
                "asset=BTCB; status=FULL_TEXT; headline=Update; publishedAt=unknown; publisherUrl=https://publisher.example/story; relevance=verified",
              evidenceRefs: ["https://publisher.example/story"],
            },
          ],
        },
        [
          ...news,
          {
            tool: "fetch_page",
            input: { url: "https://unrelated.example/story" },
            output: {
              data: "unrelated article body",
              sources: [{ url: "https://unrelated.example/story" }],
            },
          },
        ] as any,
      ),
    /matching article evidence/,
  );
  assert.doesNotThrow(() =>
    validateNewsBodyClaims(
      "news",
      {
        summary:
          "The FULL_TEXT claim was not verified, so this remains a headline only.",
        recommendation: "Observe",
        sections: [
          {
            id: "asset_news",
            content: "BTCB: FULL_TEXT was not verified; status=HEADLINE_ONLY.",
            evidenceRefs: [],
          },
        ],
      },
      [...news, failedPublisherFetch] as any,
    ),
  );
  assert.throws(
    () =>
      validateNewsBodyClaims(
        "news",
        {
          summary: "BTCB status=FULL_TEXT.",
          recommendation: "Observe",
          sections: [
            {
              id: "asset_news",
              content:
                "asset=BTCB; status=HEADLINE_ONLY; headline=Update; publishedAt=unknown; publisherUrl=https://publisher.example/story; relevance=unverified",
              evidenceRefs: [],
            },
            {
              id: "verification",
              content: "BTCB: status=FULL_TEXT verified.",
              evidenceRefs: [],
            },
          ],
        },
        [...news, articleBody] as any,
      ),
    /source-bound asset row/,
  );
  assert.throws(() => validateRoleCoverage("market", c, []), /coverage/);
  validateRoleCoverage(
    "market",
    c,
    c.universe.map((a: any) =>
      observation("market_klines", { symbol: a.marketSymbol }),
    ),
  );
  validateRoleCoverage("positions", c, []);
});
test("all-empty news searches do not force a fabricated article URL", () => {
  const c: any = {
    universe: [{ symbol: "BTCB" }, { symbol: "ETH" }, { symbol: "WBNB" }],
  };
  validateRoleCoverage(
    "news",
    c,
    ["Bitcoin", "Ethereum", "BNB"].map((query) => ({
      tool: "news_search",
      input: { query },
      output: { data: [], missing: ["no results"] },
    })),
  );
});
test("one broad news query cannot satisfy separate asset search and publisher coverage", () => {
  const c: any = {
    universe: [{ symbol: "BTCB" }, { symbol: "ETH" }, { symbol: "WBNB" }],
  };
  assert.throws(
    () =>
      validateRoleCoverage("news", c, [
        {
          tool: "news_search",
          input: { query: "Bitcoin Ethereum BNB crypto news" },
          output: {
            data: [
              { title: "Bitcoin update", url: "https://publisher.example/btc" },
              {
                title: "Ethereum update",
                url: "https://publisher.example/eth",
              },
              { title: "BNB update", url: "https://publisher.example/bnb" },
            ],
          },
        },
        {
          tool: "fetch_page",
          input: { url: "https://publisher.example/btc" },
          output: {
            data: "Bitcoin article",
            sources: [{ url: "https://publisher.example/btc" }],
          },
        },
      ]),
    /coverage/,
  );
});
test("news must attempt at least one discovered publisher for every asset", () => {
  const c: any = {
    universe: [{ symbol: "BTCB" }, { symbol: "ETH" }, { symbol: "WBNB" }],
  };
  const assetNews = {
    tool: "asset_news",
    input: { lookbackDays: 1 },
    output: {
      data: ["BTCB", "ETH", "WBNB"].map((asset) => ({
        asset,
        items: [
          {
            publisherCandidates: [
              { url: `https://${asset.toLowerCase()}.example/story` },
            ],
          },
        ],
      })),
    },
  };
  const page = (asset: string) => ({
    tool: "fetch_page",
    input: { url: `https://${asset.toLowerCase()}.example/story` },
    output: { data: null, sources: [], missing: ["page unavailable"] },
  });
  assert.throws(
    () => validateRoleCoverage("news", c, [assetNews, page("BTCB")]),
    /coverage/,
  );
  validateRoleCoverage("news", c, [
    assetNews,
    page("BTCB"),
    page("ETH"),
    page("WBNB"),
  ]);
});
import { retainReportEvidence } from "../src/research-guidance.js";
test("bounded evidence retains late cited pages and tool observations before caching report", () => {
  const proofs = Array.from({ length: 80 }, (_, i) =>
    evidence("web", "https://example.com/" + i, 1, { i }, 1),
  );
  const tool = evidence("web", "tool://fetch_page", 1, {}, 1);
  const result = retainReportEvidence([...proofs, tool], [proofs[79]!.url]);
  assert.equal(result.length, 64);
  assert(result.some((p) => p.id === proofs[79]!.id));
  assert(result.some((p) => p.id === tool.id));
  assert.throws(
    () =>
      retainReportEvidence(
        proofs,
        proofs.map((p) => p.url),
      ),
    /evidence/,
  );
});
test("Master brief prioritizes late fetched bodies over discovery headlines", () => {
  const db = new Store(":memory:");
  const proofs = Array.from({ length: 9 }, (_, i) => {
    const o = {
      tool: i === 8 ? "fetch_page" : "news_search",
      input: {},
      output: {
        data: i === 8 ? "Verified source body" : "headline",
        sources: [],
        missing: [],
      },
    };
    const e = evidence("web", "tool://" + o.tool, null, o, i);
    db.put("research-evidence", e.id, { data: normalizeEvidence(o) });
    return e;
  });
  assert(toolEvidenceBrief(db, proofs).some((e) => e.tool === "fetch_page"));
  db.close();
});
