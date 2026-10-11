import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";
import { hash } from "../src/protocol.js";
import { ConfirmedStablePlans } from "../src/confirmed-stable-plans.js";
import { stableFixture, assets } from "./helpers/stable-qsp.js";
async function setup(epochId = "1") {
  const f = await stableFixture(epochId),
    db = new Store(":memory:"),
    budget = new Budget(db),
    wallet = Wallet.createRandom().address.toLowerCase();
  db.put("epoch", epochId, f.epoch);
  db.put("agent", "investor", {
    id: "investor",
    owner: "owner",
    wallet,
    launch: "CONFIRMED",
    jailed: false,
    autoStake: true,
  });
  db.put("chain-state", "investor", {
    known: true,
    observedAt: 1050,
    bonded: "300000000000000000",
    exit: "0",
    block: 10,
    hash: "block",
    balance: "0",
  });
  budget.credit("investor", "fund", 1000n);
  const registry = {
    chainId: 56,
    confirmations: 1,
    maxBlockAgeMs: 1000,
    maxPriceAgeMs: 1000,
    assets: [
      {
        asset: "native",
        bucket: "BNB",
        decimals: 18,
        feed: Wallet.createRandom().address,
        description: "BNB / USD",
      },
      ...assets.map((a, i) => ({
        asset: a.address,
        bucket: ["BTC", "ETH", "BNB"][i],
        decimals: a.decimals,
        feed: Wallet.createRandom().address,
        description: `${a.marketSymbol} / USD`,
      })),
      {
        asset: Wallet.createRandom().address.toLowerCase(),
        bucket: "STABLE",
        decimals: 18,
        feed: Wallet.createRandom().address,
        description: "USDT / USD",
      },
    ],
  };
  const snapshot: any = {
    id: "snapshot",
    requestId: "capture",
    version: "tracked-portfolio/1",
    agent: "investor",
    wallet,
    chainId: 56,
    observedAt: 1050,
    validUntil: 1500,
    blockNumber: 10,
    blockHash: "block",
    registryHash: hash(registry),
    reservationSource: "no-pending",
    navMicros: "1000000000",
    stableValueMicros: "1000000000",
    availableStableMicros: "1000000000",
    exposures: { BTC: "0", ETH: "0", BNB: "0" },
    availableExposures: { BTC: "0", ETH: "0", BNB: "0" },
    holdings: [],
  };
  db.put("portfolio-snapshot", "snapshot", snapshot);
  db.put("portfolio-capture", "capture", {
    status: "DONE",
    snapshotId: "snapshot",
    registry,
    request: {
      agent: "investor",
      wallet,
      reserved: Object.fromEntries(registry.assets.map((a) => [a.asset, "0"])),
    },
  });
  const consumer = new ConfirmedStablePlans(db, budget, 56, 500, () => 100n);
  return { ...f, db, budget, consumer, snapshot, registry };
}
test("confirmed stable QSP creates a source-bound durable plan for a registered Worker", async () => {
  const x = await setup();
  try {
    const r = x.consumer.consume("1", "snapshot", 1100);
    assert.equal(r.status, "PLANNED");
    assert.equal(r.source!.qspHash, hash(x.epoch.output));
    assert.equal(r.qualification!.computeAvailable, "1000");
    const p = x.db.get<any>("stable-wallet-plan", r.planId!);
    assert.equal(p.orders.length, 3);
    assert.equal(p.executed, false);
    assert.deepEqual(x.consumer.consume("1", "snapshot", 1400), r);
    assert.equal(x.db.all("stable-qsp-consumption").length, 1);
  } finally {
    x.db.close();
  }
});
test("unsigned, tampered, expired, unqualified and occupied wallets leave durable rejection", async () => {
  for (const kind of [
    "tamper",
    "votes",
    "legacy",
    "expired",
    "owner",
    "stake",
    "compute",
    "future",
    "pending",
    "reservation",
    "registry",
    "lock",
    "exit",
  ]) {
    const x = await setup();
    try {
      if (kind === "tamper")
        x.epoch.output.masterSummary.stableNetworkAllocation.targets[0].targetWeightBps = 1000;
      if (kind === "votes") x.epoch.confirmation.votes.pop();
      if (kind === "legacy") {
        delete x.output.masterSummary.stableNetworkAllocation;
        await x.resign();
      }
      x.db.put("epoch", "1", x.epoch);
      if (kind === "owner")
        x.db.put("agent", "investor", {
          ...x.db.get<any>("agent", "investor"),
          wallet: Wallet.createRandom().address,
        });
      if (kind === "stake" || kind === "future" || kind === "exit")
        x.db.put("chain-state", "investor", {
          ...x.db.get<any>("chain-state", "investor"),
          ...(kind === "stake"
            ? { bonded: "0" }
            : kind === "exit"
              ? { exit: "1" }
              : { observedAt: 1200 }),
        });
      if (kind === "compute") x.budget.setChainSync("investor", true);
      if (kind === "pending")
        x.db.put("transaction", "pending", {
          sender: x.snapshot.wallet,
          state: "READY",
        });
      if (kind === "lock")
        x.db.put("sender-lock", x.snapshot.wallet, { expires: 1200 });
      if (kind === "reservation" || kind === "registry") {
        const c = x.db.get<any>("portfolio-capture", "capture");
        if (kind === "reservation") c.request.reserved.native = "1";
        else c.registry.assets[1].bucket = "ETH";
        x.db.put("portfolio-capture", "capture", c);
      }
      const r = x.consumer.consume(
        "1",
        "snapshot",
        kind === "expired" ? 1500 : 1100,
      );
      assert.equal(r.status, "REJECTED", kind);
      assert.equal(x.db.all("stable-wallet-plan").length, 0, kind);
      assert.equal(x.db.all("stable-qsp-consumption").length, 1);
    } finally {
      x.db.close();
    }
  }
});

test("three signed rounds adapt to wallet holdings and retain all source-linked outcomes", async () => {
  const x = await setup();
  try {
    const originalCapture = x.db.get<any>("portfolio-capture", "capture");
    for (let round = 1; round <= 3; round++) {
      const f = await stableFixture(String(round));
      x.db.put("epoch", String(round), f.epoch);
      const snapshot = structuredClone(x.snapshot);
      snapshot.id = `snapshot-${round}`;
      snapshot.requestId = `capture-${round}`;
      if (round === 2)
        Object.assign(snapshot, {
          stableValueMicros: "200000000",
          availableStableMicros: "200000000",
          exposures: { BTC: "0", ETH: "0", BNB: "800000000" },
          availableExposures: { BTC: "0", ETH: "0", BNB: "800000000" },
        });
      if (round === 3)
        Object.assign(snapshot, {
          stableValueMicros: "400000000",
          availableStableMicros: "400000000",
          exposures: { BTC: "200000000", ETH: "200000000", BNB: "200000000" },
          availableExposures: {
            BTC: "200000000",
            ETH: "200000000",
            BNB: "200000000",
          },
        });
      x.db.put("portfolio-snapshot", snapshot.id, snapshot);
      x.db.put("portfolio-capture", snapshot.requestId, {
        ...originalCapture,
        snapshotId: snapshot.id,
      });
      const r = x.consumer.consume(String(round), snapshot.id, 1100);
      assert.equal(r.status, "PLANNED");
      const plan = x.db.get<any>("stable-wallet-plan", r.planId!);
      assert.equal(plan.status, round === 3 ? "NO_ACTION" : "READY");
      if (round !== 3)
        assert.equal(plan.orders[0].side, round === 1 ? "BUY" : "SELL");
      assert.equal(r.source!.qspHash, hash(f.output));
    }
    assert.equal(x.db.all("stable-qsp-consumption").length, 3);
    assert.equal(x.db.all("stable-wallet-plan").length, 3);
  } finally {
    x.db.close();
  }
});

test("preexisting incompatible wallet plan yields a durable refusal instead of overwriting it", async () => {
  const x = await setup();
  try {
    x.consumer.planner.plan(
      "snapshot",
      {
        version: "stable-allocation-preview/1",
        epoch: "1",
        chainId: 56,
        createdAt: 1000,
        validUntil: 1500,
        targets: { BTC: 0, ETH: 0, BNB: 0 },
      },
      true,
      1100,
    );
    const r = x.consumer.consume("1", "snapshot", 1100);
    assert.equal(r.status, "REJECTED");
    assert.equal(r.reason, "EXISTING_WALLET_PLAN_CONFLICT");
    assert.equal(x.db.all("stable-wallet-plan").length, 1);
    assert.equal(x.db.all("stable-qsp-consumption").length, 1);
  } finally {
    x.db.close();
  }
});

test("plan and consumption linkage roll back together when final persistence fails", async () => {
  const x = await setup();
  try {
    x.db.sql.exec(
      `CREATE TRIGGER fail_consumption BEFORE INSERT ON records WHEN NEW.kind='stable-qsp-consumption' BEGIN SELECT RAISE(ABORT,'storage failure'); END;`,
    );
    assert.throws(
      () => x.consumer.consume("1", "snapshot", 1100),
      /storage failure/,
    );
    assert.equal(x.db.all("stable-wallet-plan").length, 0);
    assert.equal(x.db.all("stable-qsp-consumption").length, 0);
  } finally {
    x.db.close();
  }
});
