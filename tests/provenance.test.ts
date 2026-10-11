import { test } from "node:test";
import assert from "node:assert/strict";
import { verifiedDataAt, evidenceMissing } from "../src/provenance.js";
test("search publication and retrieval dates never substitute for verified market asOf", () => {
  const absent = { url: "", at: Date.now(), missing: true, data: null };
  assert.equal(verifiedDataAt(absent, ["https://example.com"]), 0);
  assert.ok(
    evidenceMissing(absent, [
      {
        output: {
          missing: ["undated"],
          sources: [{ url: "https://example.com", publishedAt: Date.now() }],
        },
      },
    ]).includes("undated"),
  );
  const source = {
    url: "https://market.example",
    at: 123,
    missing: false,
    data: {},
  };
  assert.equal(verifiedDataAt(source, ["https://example.com"]), 0);
  assert.equal(verifiedDataAt(source, [source.url]), 123);
});
