import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { RoundPerformanceCapture } from "../src/performance-capture.js";
test("terminal rounds get durable unknown records without inventing profit, including failed rounds", () => {
  const db = new Store(":memory:");
  try {
    db.put("agent", "a", {
      id: "a",
      wallet: "0x0000000000000000000000000000000000000001",
      createdAt: 100,
    });
    db.put("agent", "b", {
      id: "b",
      wallet: "0x0000000000000000000000000000000000000002",
      createdAt: 250,
    });
    db.put("epoch", "1", {
      id: "1",
      slot: 1,
      status: "PUBLISHED",
      finishedAt: 200,
    });
    db.put("epoch", "2", {
      id: "2",
      slot: 2,
      status: "FAILED",
      finishedAt: 300,
    });
    db.put("epoch", "3", { id: "3", slot: 3, status: "RUNNING" });
    const c = new RoundPerformanceCapture(db, 56);
    c.tick(400);
    const first = c.ledger.latest("1", 56)!;
    const second = c.ledger.latest("2", 56)!;
    assert.equal(first.roster.length, 1);
    assert.equal(second.roster.length, 2);
    assert.equal(first.network.periodPnL, null);
    assert.equal(second.network.periodPnL, null);
    assert.equal(second.windowStartMs, 200);
    assert.equal(second.windowEndMs, 300);
    assert.equal(c.ledger.latest("3", 56), undefined);
    c.tick(450);
    assert.equal(c.ledger.latest("1", 56)!.revisionHash, first.revisionHash);
  } finally {
    db.close();
  }
});

test("a wallet created exactly at the round boundary is not omitted", () => {
  const db = new Store(":memory:");
  try {
    db.put("agent", "a", {
      id: "a",
      wallet: "0x0000000000000000000000000000000000000001",
      createdAt: 200,
    });
    db.put("epoch", "1", {
      id: "1",
      slot: 1,
      status: "PUBLISHED",
      finishedAt: 200,
    });
    const c = new RoundPerformanceCapture(db, 56);
    c.tick(201);
    assert.equal(c.ledger.latest("1", 56)?.roster.length, 1);
    assert.equal(c.ledger.latest("1", 56)?.network.periodPnL, null);
  } finally {
    db.close();
  }
});

test("an unknown historical end cannot become the next round opening boundary", () => {
  const db = new Store(":memory:");
  try {
    db.put("agent", "a", {
      id: "a",
      wallet: "0x0000000000000000000000000000000000000001",
      createdAt: 100,
    });
    db.put("epoch", "1", { id: "1", slot: 1, status: "PUBLISHED" });
    db.put("epoch", "2", {
      id: "2",
      slot: 2,
      status: "FAILED",
      finishedAt: 300,
    });
    const c = new RoundPerformanceCapture(db, 56);
    c.tick(1000);
    const second = c.ledger.latest("2", 56)!;
    assert.equal(second.windowStartMs, 100);
    assert(
      second.agents[0]!.missingReasons.includes("ROUND_START_TIME_UNKNOWN"),
    );
    assert.equal(second.network.periodPnL, null);
  } finally {
    db.close();
  }
});
