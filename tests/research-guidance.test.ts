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
