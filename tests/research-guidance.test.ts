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
import { validateRoleCoverage } from "../src/research-guidance.js";
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
  const news = ["Bitcoin", "Ethereum", "BNB Chain"].map((query) =>
    observation("news_search", { query }),
  );
  validateRoleCoverage("news", c, [
    ...news,
    observation("fetch_page", { url: "https://example.com" }),
  ]);
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
