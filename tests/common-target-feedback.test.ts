import test from "node:test";
import assert from "node:assert/strict";
import { validationFeedback, ResearchTasks } from "../src/tasks.js";
import { Store } from "../src/store.js";
import { validateNetworkAllocation } from "../src/network-allocation.js";
import { validateStableNetworkAllocation } from "../src/stable-network-allocation.js";
import { stableFixture } from "./helpers/stable-qsp.js";

const missing = "network target lacks verified market evidence";
test("common-target evidence feedback is precise, sanitized and distinct from risk limits", () => {
  const feedback = validationFeedback(Error(missing));
  assert.equal(feedback.code, "EVIDENCE");
  for (const fragment of [
    "networkAllocation.targets[].evidence",
    "stableNetworkAllocation.targets[].evidence",
    "context.markets",
    "role",
    "market/news/dex/web",
    "portfolio/accounting",
    "zero",
    "null",
  ])
    assert(feedback.instruction.includes(fragment), fragment);
  for (const message of [
    "network target exceeds asset cap",
    "network targets exceed total cap",
    missing + " PRIVATE_VALUE",
    "arbitrary PRIVATE_VALUE",
  ])
    assert(
      !JSON.stringify(validationFeedback(Error(message))).includes(
        "PRIVATE_VALUE",
      ),
    );
  assert.equal(
    validationFeedback(Error("network target exceeds asset cap")).code,
    "RISK_POLICY",
  );
  assert.equal(
    validationFeedback(Error("network targets exceed total cap")).code,
    "RISK_POLICY",
  );
});

for (const stable of [false, true]) {
  test(`${stable ? "stable" : "legacy"} common zero targets need cited market evidence and can be corrected within the existing retry cap`, async () => {
    const f = await stableFixture();
    const allocation = stable
      ? structuredClone(f.allocation)
      : {
          version: "network-allocation/1",
          scope: f.allocation.scope,
          targets: structuredClone(f.allocation.targets),
          limitations: f.allocation.limitations,
        };
    const validator = stable
      ? validateStableNetworkAllocation
      : validateNetworkAllocation;
    const check = (reports = f.reports) =>
      validator(allocation, f.context, reports, 1100, 500);
    for (const target of allocation.targets) {
      target.targetWeightBps = 0;
      target.evidence = [
        f.context.liquidity.find((p) => p.asset === target.asset)!.evidenceId,
      ];
    }
    assert.throws(() => check(), { message: missing });
    const db = new Store(":memory:");
    try {
      let calls = 0;
      const tasks = new ResearchTasks(db, { maxAttempts: 2 });
      await tasks.execute(
        "correct",
        ["master"],
        Date.now() + 10000,
        () => {},
        async (_a, _id, feedback) => {
          calls++;
          if (calls === 2) {
            assert.equal(feedback?.code, "EVIDENCE");
            for (const target of allocation.targets)
              target.evidence = [
                f.context.markets.find((m) => m.address === target.asset)!
                  .evidenceId,
              ];
          }
          return check();
        },
      );
      assert.equal(calls, 2);
      assert.throws(() => check([]), { message: missing });
      allocation.targets[0]!.targetWeightBps = 10000;
      assert.throws(() => check(), /exceeds asset cap/);
      let failures = 0;
      const fail = async (
        _a: string,
        _id: string,
        feedback: ReturnType<typeof validationFeedback> | undefined,
      ) => {
        if (failures) assert.equal(feedback?.code, "EVIDENCE");
        failures++;
        throw Error(missing);
      };
      for (let resume = 0; resume < 2; resume++)
        await assert.rejects(
          new ResearchTasks(db, { maxAttempts: 2 }).execute(
            "exhaust",
            ["master"],
            Date.now() + 10000,
            () => {},
            fail,
          ),
        );
      assert.equal(failures, 2);
    } finally {
      db.close();
    }
  });
}
