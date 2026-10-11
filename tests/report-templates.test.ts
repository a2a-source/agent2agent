import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  validateReportSections,
  templateSchema,
} from "../src/report-templates.js";
test("each role and Master have distinct mandatory report sections with evidence binding", () => {
  const templates = JSON.parse(
    readFileSync("config/report-templates.json", "utf8"),
  );
  assert.deepEqual(
    Object.keys(templates).sort(),
    [
      "positions",
      "macro",
      "market",
      "news",
      "onchain",
      "risk",
      "master",
    ].sort(),
  );
  for (const t of Object.values(templates)) {
    const template = templateSchema.parse(t);
    const sections = template.sections.map((s) => ({
      id: s.id,
      content: "Known observation; uncertainty explicit",
      evidenceRefs: ["known"],
    }));
    validateReportSections(template, sections, new Set(["known"]));
    assert.throws(
      () =>
        validateReportSections(template, sections.slice(1), new Set(["known"])),
      /template/,
    );
    assert.throws(
      () =>
        validateReportSections(
          template,
          [...sections.slice(1), sections[1]!],
          new Set(["known"]),
        ),
      /template/,
    );
    assert.throws(
      () => validateReportSections(template, sections, new Set()),
      /evidence/,
    );
  }
});
