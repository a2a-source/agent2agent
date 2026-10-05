import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
test("restart retains held uncertain budget and settled credits cannot be replayed", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-test-"));
  try {
    const path = join(dir, "state.sqlite");
    let db = new Store(path),
      budget = new Budget(db);
    budget.credit("a", "chain-event", 100n);
    budget.reserve("a", "call", 60n);
    budget.unknown("call");
    db.close();
    db = new Store(path);
    budget = new Budget(db);
    budget.credit("a", "chain-event", 100n);
    assert.equal(budget.available("a"), 40n);
    budget.settle("call", 25n);
    assert.equal(budget.available("a"), 75n);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
