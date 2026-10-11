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
import { assertExecutionSource } from "../src/execution-source.js";
test("execution source rechecks current authority while allowing its own pending transaction", async () => {
  const x = await setup();
  try {
    const r = x.consumer.consume("1", "snapshot", 1100);
    x.db.put("sender-lock", x.snapshot.wallet, { expires: 1400 });
    x.db.put("transaction", "own", {
      sender: x.snapshot.wallet,
      state: "READY",
    });
    const count = x.db.sql
      .prepare("SELECT count(*) as n FROM record_history")
      .get()!.n;
    const checked = assertExecutionSource(x.consumer, r.planId!, 1200);
    assert.equal(checked.plan.id, r.planId);
    assert.equal(checked.snapshot.id, "snapshot");
    assert.equal(
      x.db.sql.prepare("SELECT count(*) as n FROM record_history").get()!.n,
      count,
    );
    x.db.put("agent", "investor", {
      ...x.db.get<any>("agent", "investor"),
      jailed: true,
    });
    assert.throws(
      () => assertExecutionSource(x.consumer, r.planId!, 1200),
      /WORKER_INELIGIBLE/,
    );
    assert.equal(x.consumer.consume("1", "snapshot", 1200).status, "PLANNED");
  } finally {
    x.db.close();
  }
});
test("execution source rejects stale or substituted source, plan and eligibility", async () => {
  for (const kind of [
    "expiry",
    "certificate",
    "qsp",
    "consumption",
    "registry",
    "snapshot",
    "orders",
    "strategy",
    "policy",
    "owner",
    "stake",
    "exit",
    "compute",
    "price",
    "future-state",
  ]) {
    const x = await setup();
    try {
      const r = x.consumer.consume("1", "snapshot", 1100);
      const plan = x.db.get<any>("stable-wallet-plan", r.planId!);
      if (kind === "certificate") x.epoch.confirmation.votes.pop();
      if (kind === "qsp") {
        x.output.risks.push("changed");
        await x.resign();
      }
      x.db.put("epoch", "1", x.epoch);
      if (kind === "consumption")
        x.db.put("stable-qsp-consumption", r.id, {
          ...r,
          source: { ...r.source, qspHash: "changed" },
        });
      if (kind === "registry") {
        const c = x.db.get<any>("portfolio-capture", "capture");
        c.registry.assets[1].bucket = "ETH";
        x.db.put("portfolio-capture", "capture", c);
      }
      if (kind === "snapshot")
        x.db.put("portfolio-snapshot", "snapshot", {
          ...x.snapshot,
          navMicros: "2000000000",
        });
      if (kind === "orders") plan.orders[0].notionalMicros = "999999999";
      if (kind === "strategy") plan.strategy.targets.BTC = 1000;
      if (kind === "policy") plan.policy.maxCycleBuyBps = 2000;
      x.db.put("stable-wallet-plan", r.planId!, plan);
      if (kind === "owner")
        x.db.put("agent", "investor", {
          ...x.db.get<any>("agent", "investor"),
          wallet: Wallet.createRandom().address,
        });
      if (["stake", "exit", "future-state"].includes(kind))
        x.db.put("chain-state", "investor", {
          ...x.db.get<any>("chain-state", "investor"),
          ...(kind === "stake"
            ? { bonded: "0" }
            : kind === "exit"
              ? { exit: "1" }
              : { observedAt: 1300 }),
        });
      if (kind === "compute") x.budget.setChainSync("investor", true);
      const consumer =
        kind === "price"
          ? new ConfirmedStablePlans(x.db, x.budget, 56, 500, () => undefined)
          : x.consumer;
      assert.throws(
        () =>
          assertExecutionSource(
            consumer,
            r.planId!,
            kind === "expiry" ? 1500 : 1200,
          ),
        Error,
        kind,
      );
    } finally {
      x.db.close();
    }
  }
});

test("a timely committee confirmation authorizes execution beyond voting deadline within QSP validity", async () => {
  const x = await setup();
  try {
    const r = x.consumer.consume("1", "snapshot", 1100);
    assert.equal(x.epoch.confirmation.expiresAt, 1400);
    assert.equal(
      assertExecutionSource(x.consumer, r.planId!, 1450).plan.id,
      r.planId,
    );
    assert.throws(() => assertExecutionSource(x.consumer, r.planId!, 1500));
  } finally {
    x.db.close();
  }
});
