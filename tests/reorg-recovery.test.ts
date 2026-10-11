import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";

test("canonical tax reconciliation reverses orphaned income without erasing paid compute or manual funding", () => {
  const db = new Store(":memory:"),
    budget = new Budget(db);
  budget.credit("agent", "manual:funding", 100n);
  budget.reconcileChain("agent", 97, [
    { source: "97:tx:0", amount: "100", block: 10, blockHash: "canonical-a" },
  ]);
  budget.reserve("agent", "paid", 150n);
  budget.settle("paid", 120n);
  assert.equal(budget.available("agent"), 80n);
  budget.reconcileChain("agent", 97, []);
  assert.equal(budget.available("agent"), -20n);
  assert.equal(db.get<any>("reservation", "paid").actual, "120");
  assert.throws(() => budget.reserve("agent", "next", 1n), /insufficient/);
  budget.reconcileChain("agent", 97, [
    { source: "97:newtx:0", amount: "50", block: 11, blockHash: "canonical-b" },
  ]);
  assert.equal(budget.available("agent"), 30n);
  budget.reconcileChain("agent", 97, [
    { source: "97:newtx:0", amount: "50", block: 11, blockHash: "canonical-b" },
  ]);
  assert.equal(budget.available("agent"), 30n);
  db.close();
});

test("reconciliation freezes new spending and preserves ambiguous call holds until canonical scan completes", () => {
  const db = new Store(":memory:"),
    budget = new Budget(db);
  budget.credit("agent", "manual:funding", 200n);
  budget.reserve("agent", "pending", 70n);
  budget.unknown("pending");
  budget.setChainSync("agent", true);
  assert.equal(budget.available("agent"), 0n);
  assert.throws(() => budget.reserve("agent", "next", 1n), /insufficient/);
  budget.settle("pending", 60n);
  budget.reconcileChain("agent", 97, []);
  assert.equal(budget.available("agent"), 0n);
  budget.setChainSync("agent", false);
  assert.equal(budget.available("agent"), 140n);
  db.close();
});

test("legacy credits reconcile automatically but unrelated networks and manual receipts are preserved", () => {
  const db = new Store(":memory:"),
    budget = new Budget(db);
  budget.credit("agent", "97:old:0", 90n);
  budget.credit("agent", "56:other:0", 40n);
  budget.credit("agent", "manual:foo", 20n);
  budget.reconcileChain("agent", 97, []);
  assert.equal(budget.available("agent"), 60n);
  budget.reconcileChain("agent", 97, [
    { source: "97:old:0", amount: "90", block: 20, blockHash: "canonical" },
  ]);
  assert.equal(budget.available("agent"), 150n);
  assert.throws(
    () =>
      budget.reconcileChain("agent", 97, [
        {
          source: "56:other:0",
          amount: "40",
          block: 20,
          blockHash: "canonical",
        },
      ]),
    /receipt/,
  );
  assert.equal(budget.available("agent"), 150n);
  db.close();
});

test("watcher automatically rescans an EVM reorganization and restores eligibility accounting without operator edits", async () => {
  const [
    { default: ganache },
    { BrowserProvider, ContractFactory },
    { compileContracts },
    { generateKeyPairSync },
    { WalletVault },
    { Agents },
    { Journal },
    { Watcher },
  ] = await Promise.all([
    import("ganache"),
    import("ethers"),
    import("../src/contracts.js"),
    import("node:crypto"),
    import("../src/wallet.js"),
    import("../src/agents.js"),
    import("../src/chain.js"),
    import("../src/watcher.js"),
  ]);
  const transport = ganache.provider({
      logging: { quiet: true },
      chain: { chainId: 97, hardfork: "shanghai" },
    }),
    provider = new BrowserProvider(transport as any, undefined, {
      cacheTimeout: -1,
    });
  const db = new Store(":memory:");
  try {
    const signer = await provider.getSigner(),
      keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      agents = new Agents(
        db,
        new WalletVault(
          keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
          keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          "test",
        ),
      ),
      a = agents.create(agents.createUser("owner").id, "test", {
        name: "Agent",
        symbol: "A",
        meta: "bafy",
      }),
      budget = new Budget(db),
      artifacts = compileContracts();
    const stake = await new ContractFactory(
      artifacts.AgentStake!.abi,
      artifacts.AgentStake!.bytecode,
      signer,
    ).deploy(1);
    await stake.waitForDeployment();
    const split = await new ContractFactory(
      artifacts.RevenueSplitter!.abi,
      artifacts.RevenueSplitter!.bytecode,
      signer,
    ).deploy(await signer.getAddress(), a.wallet);
    await split.waitForDeployment();
    agents.update(a.id, {
      splitter: await split.getAddress(),
      launch: "CONFIRMED",
      token: a.wallet,
    });
    const watcher = new Watcher(
      agents,
      budget,
      new Journal(db, provider, 97, false),
      await stake.getAddress(),
      1,
      0,
      0n,
    );
    await watcher.tick();
    const snapshot = await transport.request({
      method: "evm_snapshot",
      params: [],
    });
    await (
      await signer.sendTransaction({
        to: await split.getAddress(),
        value: 100000n,
      })
    ).wait();
    await watcher.tick();
    assert.equal(budget.available(a.id), 15000n);
    budget.reserve(a.id, "billed", 12000n);
    budget.settle("billed", 10000n);
    await transport.request({ method: "evm_revert", params: [snapshot] });
    await (await signer.sendTransaction({ to: a.wallet, value: 1n })).wait();
    await watcher.tick();
    assert.equal(budget.available(a.id), -10000n);
    assert.equal(db.get<any>("chain-state", a.id).known, true);
    assert.equal(db.get<any>("reservation", "billed").actual, "10000");
    await (
      await signer.sendTransaction({
        to: await split.getAddress(),
        value: 100000n,
      })
    ).wait();
    await watcher.tick();
    await watcher.tick();
    assert.equal(budget.available(a.id), 5000n);
  } finally {
    db.close();
    await transport.disconnect();
  }
});

test("tax recovery pagination survives restart and keeps budget frozen until the entire canonical range is checked", async () => {
  const { TaxSync } = await import("../src/tax-sync.js"),
    { Interface } = await import("ethers");
  const db = new Store(":memory:"),
    budget = new Budget(db),
    agent: any = {
      id: "a",
      splitter: "0x1111111111111111111111111111111111111111",
    };
  const iface = new Interface([
      "event PlatformPaid(uint256 amount,uint256 compute)",
    ]),
    encoded = iface.encodeEventLog(iface.getEvent("PlatformPaid")!, [30n, 15n]);
  const provider: any = {
    getBlock: async (n: number) => ({ hash: `block:${n}` }),
    getLogs: async (query: any) =>
      query.fromBlock <= 1200 && query.toBlock >= 1200
        ? [
            {
              ...encoded,
              address: agent.splitter,
              blockNumber: 1200,
              blockHash: "block:1200",
              removed: false,
              transactionHash: "receipt",
              index: 0,
            },
          ]
        : [],
  };
  budget.credit("a", "manual:funding", 20n);
  const make = () =>
    new TaxSync({ db } as any, budget, { provider, chainId: 97 } as any, 0, 1);
  assert.equal(
    await make().sync(agent, { height: 2500, hash: "block:2500" }),
    false,
  );
  assert.equal(budget.available("a"), 0n);
  assert.equal(db.get<any>("tax-scan", "a").next, 1000);
  assert.equal(
    await make().sync(agent, { height: 2500, hash: "block:2500" }),
    false,
  );
  assert.equal(budget.available("a"), 0n);
  assert.equal(
    await make().sync(agent, { height: 2500, hash: "block:2500" }),
    true,
  );
  assert.equal(budget.available("a"), 35n);
  assert.equal(db.all("tax-scan-receipt").length, 0);
  assert.equal(
    await make().sync(agent, { height: 2500, hash: "block:2500" }),
    true,
  );
  assert.equal(budget.available("a"), 35n);
  db.close();
});
