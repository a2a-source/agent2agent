import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Agents } from "../src/agents.js";
import type { WalletVault } from "../src/wallet.js";
import { Budget } from "../src/budget.js";
import { Epochs } from "../src/epochs.js";
import { Llm } from "../src/llm.js";
import { Runner } from "../src/runner.js";
import { Scheduler } from "../src/scheduler.js";
import { ResearchData } from "../src/research-data.js";
import {
  contextSchema,
  portfolioSnapshot,
  compareContext,
} from "../src/research-context.js";
import { hash } from "../src/protocol.js";
import { loadConfig } from "./test-config.js";

function fixture(t: TestContext) {
  const db = new Store(":memory:");
  t.after(() => db.close());
  const config = loadConfig();
  config.research.enabled = true;
  config.network.epochMs = 15000;
  config.network.timeoutMs = 1800000;
  const agents = new Agents(db, {} as WalletVault),
    budget = new Budget(db),
    epochs = new Epochs(db);
  for (let i = 1; i <= 3; i++) {
    const id = String(i);
    db.put("agent", id, {
      id,
      wallet: "0x" + id.repeat(40),
      owner: "fixture",
      name: id,
      symbol: "T",
      meta: "fixture",
      launch: "CONFIRMED",
      autoStake: false,
      jailed: false,
      createdAt: Date.now(),
    });
    db.put("chain-state", id, {
      known: true,
      bonded: "300000000000000000",
      exit: "0",
      observedAt: Date.now(),
    });
    budget.credit(id, id, 10000000n);
  }
  const llm = new Llm(db, budget, config.llm, "fixture"),
    runner = new Runner(agents, budget, epochs, llm, config);
  const epoch = epochs.open(0, runner.candidates(), config.network);
  const version = hash({
    roles: config.roles,
    reportTemplates: config.reportTemplates,
    master: config.masterPrompt,
    llm: config.llm,
    agent: config.agent,
    research: config.research,
  });
  const context = contextSchema.parse({
    version: "research-context/1",
    at: Date.now() - config.research.maxAgeMs - 1,
    chainId: config.research.chainId,
    universe: config.research.assets,
    portfolio: portfolioSnapshot([], false),
    portfolioIdentity: {
      wallet: "fixture",
      scope: "CONFIGURED_ASSETS_AND_NATIVE",
      blockNumber: null,
      blockHash: null,
      nativeBalanceWei: null,
      gasReserveWei: "0",
      stakeExcluded: true,
    },
    markets: [],
    liquidity: [],
    news: [],
    evidence: [],
    missing: ["fixture unavailable"],
    previous: null,
    changes: compareContext(undefined, {
      portfolio: portfolioSnapshot([], false),
      markets: [],
    }),
    policy: {
      maxAssetBps: 3000,
      maxTotalBps: 8000,
      validForMs: 300000,
      minLiquidityUsd: 1000000,
      maxSlippageBps: 100,
    },
  });
  return { db, config, epochs, llm, runner, epoch, version, context };
}

for (const failure of ["configuration", "context"] as const) {
  test(`${failure} that cannot recover within a frozen round terminates and schedules a fresh round`, async (t) => {
    let now = 2000000000000;
    t.mock.method(Date, "now", () => now);
    const { db, config, epochs, llm, runner, epoch, version, context } =
      fixture(t);
    db.put("run-config", epoch.id, {
      version: failure === "configuration" ? "old-configuration" : version,
    });
    const saved = { version, hash: hash(context), context };
    db.put("research-context", epoch.id, saved);
    await assert.rejects(
      runner.run(epoch),
      failure === "configuration"
        ? /configuration changed/
        : /context data expired/,
    );
    const terminal = epochs.get(epoch.id);
    assert.equal(terminal.status, "FAILED");
    assert.equal(terminal.finishedAt, now);
    assert.equal(terminal.nextEligibleAt, now + 15000);
    assert.equal(
      db.get<any>("research-failure", `${epoch.id}:0`).code,
      failure === "configuration"
        ? "RUN_CONFIGURATION_CHANGED"
        : "RESEARCH_CONTEXT_EXPIRED",
    );
    assert.deepEqual(db.get("research-context", epoch.id), saved);
    assert.equal(db.all("research-attempt").length, 0);
    assert.equal(db.all("llm-request").length, 0);
    assert.ok(runner.agents.list().every((a) => !a.jailed));
    t.mock.method(ResearchData.prototype, "collect", async () => ({
      ...context,
      at: now,
    }));
    t.mock.method(llm, "call", async () => {
      throw Error("LLM HTTP 503");
    });
    const scheduler = new Scheduler(runner, {
      observeResearch() {},
      async recoverOperational() {},
    } as any);
    await scheduler.tick();
    assert.equal(db.all("epoch").length, 1);
    now += 15000;
    await scheduler.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const next = epochs.get("1");
    assert.equal(next.status, "RUNNING");
    assert.equal(db.get<any>("run-config", "1").version, version);
    assert.equal(db.get<any>("research-context", "1").context.at, now);
    assert.equal(db.get<any>("incident", "1:0:failure").reason, "PROVIDER");
    assert.equal(db.get<any>("research-failure", "1:0").terminal, false);
    assert.equal(config.network.timeoutMs, 1800000);
    await scheduler.stop();
  });
}

test("unknown errors retain takeover behavior and persist no arbitrary secret-bearing text", async (t) => {
  const { db, epochs, runner, epoch } = fixture(t);
  t.mock.method(runner, "candidates", () => {
    throw Error("private-key=DO_NOT_PERSIST");
  });
  await assert.rejects(runner.run(epoch), /DO_NOT_PERSIST/);
  assert.equal(epochs.get(epoch.id).status, "RUNNING");
  assert.deepEqual(db.get<any>("research-failure", `${epoch.id}:0`), {
    id: `${epoch.id}:0`,
    epoch: epoch.id,
    view: 0,
    failure: "PLATFORM",
    code: "UNCLASSIFIED",
    terminal: false,
    at: db.get<any>("research-failure", `${epoch.id}:0`)?.at,
  });
  assert.ok(
    !JSON.stringify(db.all("research-failure")).includes("DO_NOT_PERSIST"),
  );
});

for (const supersededBy of ["new view", "confirmation proposal"] as const) {
  test(`a late config failure cannot terminate a ${supersededBy}`, async (t) => {
    const { db, epochs, runner, epoch } = fixture(t);
    const candidates = runner.candidates();
    db.put("run-config", epoch.id, { version: "old-configuration" });
    t.mock.method(runner, "candidates", () => {
      if (supersededBy === "new view")
        db.put("epoch", epoch.id, { ...epoch, view: epoch.view + 1 });
      else db.put("confirmation-proposal", epoch.id, { fixture: true });
      return candidates;
    });
    await assert.rejects(runner.run(epoch), /configuration changed/);
    assert.equal(epochs.get(epoch.id).status, "RUNNING");
    assert.equal(epochs.get(epoch.id).finishedAt, undefined);
    if (supersededBy === "new view") {
      assert.equal(epochs.get(epoch.id).view, 1);
      assert.equal(db.get<any>("research-failure", "0:0").terminal, false);
    } else {
      assert.deepEqual(db.get("confirmation-proposal", epoch.id), {
        fixture: true,
      });
      assert.equal(db.get("research-failure", "0:0"), undefined);
      assert.equal(db.get("incident", "0:0:failure"), undefined);
    }
  });
}
