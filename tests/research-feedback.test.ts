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
