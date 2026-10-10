import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { ResearchTasks } from "../src/tasks.js";
test("bounded validation feedback survives restart without leaking error text", async () => {
  const db = new Store(":memory:");
  const t = new ResearchTasks(db, { maxAttempts: 1 });
  let count = 0;
  await assert.rejects(
    t.execute(
      "r",
      ["a"],
      Date.now() + 10000,
      () => {},
      async () => {
        count++;
        throw Error("signal exceeds risk policy secret-key");
      },
    ),
  );
  const resumed = new ResearchTasks(db, { maxAttempts: 2 });
  const result = await resumed.execute(
    "r",
    ["a"],
    Date.now() + 10000,
    () => {},
    async (_a, _id, feedback) => {
      count++;
      assert.equal(feedback?.code, "RISK_POLICY");
      assert(!JSON.stringify(feedback).includes("secret-key"));
      return "ok";
    },
  );
  assert.equal(result, "ok");
  assert.equal(count, 2);
  db.close();
});
test("invalid output exhausts existing cap and provider failure has no model correction", async () => {
  const db = new Store(":memory:");
  const t = new ResearchTasks(db, { maxAttempts: 2 });
  let calls = 0;
  await assert.rejects(
    t.execute(
      "x",
      ["a"],
      Date.now() + 10000,
      () => {},
      async (_a, _id, feedback) => {
        calls++;
        if (calls === 2) assert.equal(feedback, undefined);
        throw Error("LLM HTTP 503");
      },
    ),
  );
  assert.equal(calls, 2);
  db.close();
});
import { classifyResearchFailure } from "../src/tasks.js";
test("provider policy rejection and stale data are not blamed on model output", () => {
  assert.equal(
    classifyResearchFailure(Error("LLM HTTP 403 provider policy rejection")),
    "PROVIDER",
  );
  assert.equal(
    classifyResearchFailure(Error("market data expired or unavailable")),
    "DATA",
  );
  assert.equal(
    classifyResearchFailure(Error("Agent final JSON unavailable")),
    "INVALID_OUTPUT",
  );
});
test("exhausted retry preserves fault classification after restart", async () => {
  const db = new Store(":memory:");
  const t = new ResearchTasks(db, { maxAttempts: 2 });
  const fail = async () => {
    throw Error("signal exceeds risk policy");
  };
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      t.execute("repeat", ["a"], Date.now() + 10000, () => {}, fail),
      (e) => classifyResearchFailure(e) === "INVALID_OUTPUT",
    );
  db.close();
});
test("nonretryable persisted failures cannot resume into another attempt", async () => {
  for (const message of [
    "market data expired or unavailable",
    "internal invariant broken",
  ]) {
    const db = new Store(":memory:");
    let calls = 0;
    const t = new ResearchTasks(db, { maxAttempts: 2 });
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        t.execute(
          "stop",
          ["a"],
          Date.now() + 10000,
          () => {},
          async () => {
            calls++;
            throw Error(message);
          },
        ),
      );
    assert.equal(calls, 1);
    db.close();
  }
});
import { z } from "zod";
test("schema source fields are output errors rather than data-source failures", () => {
  const result = z.object({ sources: z.array(z.string()) }).safeParse({});
  assert(!result.success);
  assert.equal(classifyResearchFailure(result.error), "INVALID_OUTPUT");
});
test("fabricated source stays an invalid model output", () =>
  assert.equal(
    classifyResearchFailure(Error("fabricated source")),
    "INVALID_OUTPUT",
  ));
import { validationFeedback } from "../src/tasks.js";
test("missing top-level evidenceIds is a schema correction, not a source citation error", () => {
  const e = z
    .object({ summary: z.string(), evidenceIds: z.array(z.string()) })
    .safeParse({ sections: [] });
  assert(!e.success);
  assert.equal(validationFeedback(e.error).code, "OUTPUT_FORMAT");
  assert.match(validationFeedback(e.error).instruction, /summary/);
});

test("missing market citation feedback distinguishes holdings and pools from required price evidence", () => {
  const feedback = validationFeedback(
    Error("signal lacks fresh verified market evidence"),
  );
  assert.equal(feedback.code, "EVIDENCE");
  assert.match(feedback.instruction, /signalEvidenceRequirements/);
  assert.match(feedback.instruction, /portfolio/);
});

test("unsupported FULL_TEXT labels receive a focused correction and retry as invalid output", () => {
  const error = Error("news FULL_TEXT claim lacks matching article evidence");
  assert.equal(classifyResearchFailure(error), "INVALID_OUTPUT");
  assert.match(validationFeedback(error).instruction, /HEADLINE_ONLY/);
  assert.match(
    validationFeedback(error).instruction,
    /matching publisher candidate/,
  );
});
test("malformed news verification rows are model errors, not source outages", () => {
  const error = Error("news FULL_TEXT claim lacks a source-bound asset row");
  assert.equal(classifyResearchFailure(error), "INVALID_OUTPUT");
  assert.equal(validationFeedback(error).code, "ROLE_COVERAGE");
});

import { researchReportSchema, normalizeReport } from "../src/qsp-v2.js";
const validReport = {
  summary: "observed",
  missing: [],
  evidenceIds: [],
  recommendation: "wait",
  uncertainty: "limited",
  sections: [{ id: "market", content: "observed", evidenceRefs: [] }],
};
test("object section content and extra template keys receive accurate corrections", () => {
  const parsed = researchReportSchema.safeParse({
    ...validReport,
    sections: [
      {
        id: "market",
        content: { secret: "PRIVATE_VALUE" },
        evidenceRefs: [],
        title: "PRIVATE_VALUE",
        instruction: "PRIVATE_VALUE",
      },
    ],
  });
  assert(!parsed.success);
  const feedback = validationFeedback(parsed.error).instruction;
  assert.match(feedback, /sections\[0\]\.content.*string/);
  assert.match(feedback, /only id, content, evidenceRefs/);
  assert.doesNotMatch(feedback, /PRIVATE_VALUE|ALL required fields/);
});
test("oversized news identifies actual content maximum without claiming absent root fields", () => {
  const parsed = researchReportSchema.safeParse({
    ...validReport,
    sections: [
      { id: "asset_news", content: "x".repeat(2814), evidenceRefs: [] },
    ],
  });
  assert(!parsed.success);
  const feedback = validationFeedback(parsed.error).instruction;
  assert.match(feedback, /sections\[0\]\.content.*maximum.*2400/);
  assert.doesNotMatch(feedback, /ALL required fields|missing root/);
  assert(researchReportSchema.safeParse(validReport).success);
});
test("schema feedback bounds issues and sanitizes arbitrary paths and messages", () => {
  const error = new z.ZodError(
    Array.from({ length: 100 }, () => ({
      code: "too_small",
      type: "string",
      minimum: 1,
      inclusive: true,
      exact: false,
      path: ["SECRET_INSTRUCTION", 0, "content"],
      message: "PRIVATE_VALUE",
    })),
  );
  const feedback = validationFeedback(error).instruction;
  assert(feedback.length <= 1800);
  assert.match(feedback, /minimum.*1/);
  assert.doesNotMatch(feedback, /SECRET_INSTRUCTION|PRIVATE_VALUE/);
});
test("root tool URLs remain rejected and feedback distinguishes the two reference locations", () => {
  let failure: unknown;
  try {
    normalizeReport(
      { ...validReport, evidenceIds: ["https://source.example/market"] },
      { evidence: [] } as any,
    );
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof Error);
  const feedback = validationFeedback(failure);
  assert.equal(feedback.code, "EVIDENCE");
  assert.match(feedback.instruction, /root evidenceIds.*frozen/);
  assert.match(
    feedback.instruction,
    /sections\[\]\.evidenceRefs.*observed tool/,
  );
});
test("fallback specifies string content and array references without template metadata", () => {
  const feedback = validationFeedback(
    new SyntaxError("PRIVATE_VALUE"),
  ).instruction;
  assert.match(feedback, /content.*string/);
  assert.match(feedback, /evidenceRefs.*array/);
  assert.match(feedback, /only id, content, evidenceRefs/);
});

import { validateReportSections } from "../src/report-templates.js";
import { validateNewsBodyClaims } from "../src/research-guidance.js";
test("concise unresolved publisher headlines retain observed refs within unchanged section bounds", () => {
  const refs = [
    "https://news.example/btc",
    "https://news.example/eth",
    "https://news.example/bnb",
  ];
  const content =
    ["BTCB", "ETH", "WBNB"]
      .map(
        (asset) =>
          `asset=${asset}; status=HEADLINE_ONLY; headline=${asset} update; publishedAt=2026-10-10T00:00:00Z; publisherUrl=UNKNOWN; relevance=unverified`,
      )
      .join("\n") +
    "\nPublisher resolution unavailable; other discovered headlines omitted.";
  const report = researchReportSchema.parse({
    ...validReport,
    sections: [{ id: "asset_news", content, evidenceRefs: refs }],
  });
  assert.deepEqual(
    validateReportSections(
      {
        version: "role-report/1",
        title: "News",
        sections: [{ id: "asset_news", title: "News", instruction: "Review" }],
      },
      report.sections,
      new Set(refs),
    ),
    report.sections,
  );
  validateNewsBodyClaims("news", report, []);
  assert.throws(
    () =>
      validateNewsBodyClaims(
        "news",
        {
          ...report,
          sections: [
            {
              ...report.sections![0]!,
              content: content.replace(
                "status=HEADLINE_ONLY",
                "status=FULL_TEXT",
              ),
            },
          ],
        },
        [],
      ),
    /news FULL_TEXT claim/,
  );
  assert.throws(
    () =>
      validateReportSections(
        {
          version: "role-report/1",
          title: "News",
          sections: [
            { id: "asset_news", title: "News", instruction: "Review" },
          ],
        },
        report.sections,
        new Set(),
      ),
    /fabricated evidence/,
  );
});
