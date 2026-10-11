import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { StableWalletPlanner } from "../src/stable-wallet-plan.js";
import type { PortfolioSnapshot } from "../src/portfolio-snapshot.js";
const strategy = {
  version: "stable-allocation-preview/1",
  epoch: "round-1",
  chainId: 97,
  createdAt: 1000,
  validUntil: 2000,
  targets: { BTC: 2000, ETH: 2000, BNB: 2000 },
};
function setup() {
  const db = new Store(":memory:");
  const snapshot: PortfolioSnapshot = {
    id: "snapshot",
    requestId: "capture",
    agent: "a",
    wallet: "0x" + "11".repeat(20),
    chainId: 97,
    version: "tracked-portfolio/1",
    observedAt: 1000,
    validUntil: 2000,
    blockNumber: 10,
    blockHash: "0x" + "11".repeat(32),
    registryHash: "registry",
    reservationSource: "reservations",
    navMicros: "1000000000",
    stableValueMicros: "1000000000",
    availableStableMicros: "1000000000",
    exposures: { BTC: "0", ETH: "0", BNB: "0" },
    availableExposures: { BTC: "0", ETH: "0", BNB: "0" },
    holdings: [],
  };
  db.put("portfolio-snapshot", snapshot.id, snapshot);
  db.put("portfolio-capture", "capture", {
    status: "DONE",
    snapshotId: snapshot.id,
  });
  return { db, snapshot };
}
test("stable plan buys proportionally within per-round ten percent and persists immutable result", () => {
  const { db } = setup();
  try {
    const planner = new StableWalletPlanner(db);
    const p = planner.plan("snapshot", strategy, true, 1100);
    assert.equal(p.status, "READY");
    assert.equal(p.executed, false);
    assert.equal(p.orders.length, 3);
    assert.ok(
      p.orders.reduce((n, o) => n + BigInt(o.notionalMicros), 0n) <= 100000000n,
    );
    assert.deepEqual(planner.plan("snapshot", strategy, true, 5000), p);
    assert.throws(
      () =>
        planner.plan(
          "snapshot",
          { ...strategy, targets: { BTC: 1000, ETH: 2000, BNB: 2000 } },
          true,
          1100,
        ),
      /conflict/,
    );
  } finally {
    db.close();
  }
});
test("BNB overweight generates only reductions and does not spend expected proceeds", () => {
  const { db, snapshot } = setup();
  try {
    Object.assign(snapshot, {
      stableValueMicros: "200000000",
      availableStableMicros: "200000000",
      exposures: { BTC: "0", ETH: "0", BNB: "800000000" },
      availableExposures: { BTC: "0", ETH: "0", BNB: "800000000" },
    });
    db.put("portfolio-snapshot", "snapshot", snapshot);
    const p = new StableWalletPlanner(db).plan(
      "snapshot",
      strategy,
      true,
      1100,
    );
    assert.deepEqual(
      p.orders.map((o) => [o.side, o.bucket, o.notionalMicros]),
      [["SELL", "BNB", "600000000"]],
    );
    assert.equal(p.phase, "REDUCE_FIRST");
  } finally {
    db.close();
  }
});
test("ineligible, expired, caps, uncertain capture and reserved reductions cannot produce buys", () => {
  for (const kind of ["worker", "expired", "caps", "capture", "reserved"]) {
    const { db, snapshot } = setup();
    try {
      if (kind === "capture")
        db.put("portfolio-capture", "capture", {
          status: "READING",
          snapshotId: "snapshot",
        });
      if (kind === "reserved") {
        Object.assign(snapshot, {
          stableValueMicros: "200000000",
          availableStableMicros: "200000000",
          exposures: { BTC: "0", ETH: "0", BNB: "800000000" },
        });
        db.put("portfolio-snapshot", "snapshot", snapshot);
      }
      const s = structuredClone(strategy);
      if (kind === "caps") s.targets.BTC = 3000;
      const p = new StableWalletPlanner(db).plan(
        "snapshot",
        s,
        kind !== "worker",
        kind === "expired" ? 3000 : 1100,
      );
      assert.equal(p.status, "BLOCKED");
      assert.equal(p.orders.length, 0);
      assert.equal(db.all("stable-wallet-plan").length, 1);
    } finally {
      db.close();
    }
  }
});

test("wallet policy may tighten but cannot relax the approved exposure and buy ceilings", () => {
  const { db } = setup();
  try {
    for (const [key, value] of [
      ["maxUnderlyingBps", 2001],
      ["maxVolatileBps", 6001],
      ["maxOrderBuyBps", 1001],
      ["maxCycleBuyBps", 1001],
    ])
      assert.throws(
        () => new StableWalletPlanner(db, { [key as string]: value }),
        /ceiling/,
      );
  } finally {
    db.close();
  }
});
