import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/store.js";
import { InvestmentPreviewJournal } from "../src/investment-preview-journal.js";
const fixture = () =>
  JSON.parse(readFileSync("examples/investment-preview.json", "utf8"));
test("preview persists input and outcome and idempotently replays", () => {
  const db = new Store(":memory:");
  try {
    const input = fixture();
    const journal = new InvestmentPreviewJournal(db);
    const result = journal.preview(input, 1100);
    assert.equal(result.status, "DONE");
    assert.equal(result.output!.executed, false);
    assert.equal(result.input.strategy.id, input.strategy.id);
    assert.deepEqual(
      new InvestmentPreviewJournal(db).preview(input, 1100),
      result,
    );
    assert.equal(db.all("investment-preview").length, 1);
    assert.equal(db.all<any>("investment-preview")[0].evaluatedAt, 1100);
  } finally {
    db.close();
  }
});
test("business refusal persists typed input; invalid schema is not archived as trusted protocol data", () => {
  const db = new Store(":memory:");
  try {
    const journal = new InvestmentPreviewJournal(db);
    const result = journal.preview(fixture(), 999999999);
    assert.equal(result.status, "REJECTED");
    assert.equal(result.reason, "PLANNER_VALIDATION_FAILED");
    assert.equal(db.all("investment-preview").length, 1);
    assert.throws(() => journal.preview({ secret: "should-not-store" }, 1100));
    assert.ok(
      !JSON.stringify(db.all("investment-preview")).includes(
        "should-not-store",
      ),
    );
  } finally {
    db.close();
  }
});

test("three synthetic rounds survive restart with BUY, at-target and SELL artifacts", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "a2a-preview-"));
  const path = join(dir, "test.sqlite");
  let db = new Store(path);
  try {
    const first = fixture();
    const buy = new InvestmentPreviewJournal(db).preview(first, 1100);
    assert.equal(buy.output!.items[0]!.side, "BUY");
    db.close();
    db = new Store(path);
    const second = fixture();
    second.strategy.id = "round-2";
    second.snapshot.nativeBalanceWei = "8020000000000000000";
    second.snapshot.positions[0].balance = "1980000000000000000";
    const hold = new InvestmentPreviewJournal(db).preview(second, 1100);
    assert.equal(hold.output!.items.length, 0);
    const third = structuredClone(second);
    third.strategy.id = "round-3";
    third.strategy.targets[0].weightBps = 0;
    const sell = new InvestmentPreviewJournal(db).preview(third, 1100);
    assert.equal(sell.output!.items[0]!.side, "SELL");
    db.close();
    db = new Store(path);
    assert.equal(db.all("investment-preview").length, 3);
    assert.deepEqual(
      new InvestmentPreviewJournal(db).preview(first, 1100),
      buy,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
