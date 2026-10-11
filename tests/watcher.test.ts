import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import ganache from "ganache";
import {
  BrowserProvider,
  ContractFactory,
  Wallet,
  parseEther,
  Contract,
} from "ethers";
import { compileContracts } from "../src/contracts.js";
import { Store } from "../src/store.js";
import { WalletVault } from "../src/wallet.js";
import { Agents } from "../src/agents.js";
import { Budget } from "../src/budget.js";
import { Journal } from "../src/chain.js";
import { Watcher, STAKE_ABI } from "../src/watcher.js";
import { FlapLauncher } from "../src/flap.js";
test("local EVM launch retry, external funding, auto stake and tax ingestion survive repeated polling", async () => {
  const transport = ganache.provider({
    logging: { quiet: true },
    chain: { chainId: 97, hardfork: "shanghai" },
  });
  const provider = new BrowserProvider(transport as any, undefined, {
    cacheTimeout: -1,
  });
  const db = new Store(":memory:");
  try {
    const accounts = transport.getInitialAccounts(),
      operator = new Wallet(Object.values(accounts)[0]!.secretKey),
      deployer = await provider.getSigner(0);
    const artifacts = compileContracts({
      "MockFlap.sol": {
        content: readFileSync("tests/fixtures/MockFlap.sol", "utf8"),
      },
    });
    async function deploy(name: string, args: unknown[] = []) {
      const c = await new ContractFactory(
        artifacts[name]!.abi,
        artifacts[name]!.bytecode,
        deployer,
      ).deploy(...args);
      await c.waitForDeployment();
      return c;
    }
    const implementation = await deploy("MockTaxToken"),
      portal = await deploy("MockFlap", [await implementation.getAddress()]),
      factory = await deploy("SplitterFactory", [operator.address]),
      stake = await deploy("AgentStake", [1]);
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
      vault = new WalletVault(
        keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        "v1",
      );
    const agents = new Agents(db, vault),
      user = agents.createUser("test"),
      a = agents.create(user.id, "1", { name: "A", symbol: "A", meta: "bafy" }),
      budget = new Budget(db),
      journal = new Journal(db, provider, 97, true);
    const launcher = new FlapLauncher(agents, journal, operator, {
      portal: await portal.getAddress(),
      implementation: await implementation.getAddress(),
      factory: await factory.getAddress(),
      taxDuration: 86400,
      launchValueWei: "0",
      confirmations: 1,
    });
    for (let i = 0; i < 4 && agents.get(a.id).launch !== "CONFIRMED"; i++)
      await launcher.advance(a.id);
    assert.equal(agents.get(a.id).launch, "CONFIRMED");
    const count = db.all("transaction").length;
    await launcher.advance(a.id);
    assert.equal(db.all("transaction").length, count);
    await (
      await deployer.sendTransaction({ to: a.wallet, value: parseEther("0.8") })
    ).wait();
    const watcher = new Watcher(
      agents,
      budget,
      journal,
      await stake.getAddress(),
      1,
      0,
      parseEther("0.001"),
    );
    const snapshot = await provider.getBlockNumber();
    await watcher.tick();
    const getHeight = provider.getBlockNumber.bind(provider);
    provider.getBlockNumber = async () => snapshot;
    await watcher.tick(); // Deposit confirmed above the selected historical snapshot.
    provider.getBlockNumber = getHeight;
    assert.equal(
      db.all<any>("transaction").filter((t) => t.id.startsWith("stake:"))
        .length,
      1,
    );
    await watcher.tick();
    assert.equal(
      await stake.getFunction("bonded")(a.wallet),
      parseEther("0.3"),
    );
    const split = agents.get(a.id).splitter!;
    await (
      await deployer.sendTransaction({ to: split, value: 100000n })
    ).wait();
    await watcher.tick();
    await watcher.tick();
    assert.equal(budget.available(a.id), 15000n);
    const state = db.get<any>("chain-state", a.id);
    assert.equal(state.bonded, "300000000000000000");
    assert.equal(state.known, true);
    await watcher.exit(a.id);
    await watcher.tick();
    assert.equal(agents.get(a.id).autoStake, false);
    assert.equal(await stake.getFunction("bonded")(a.wallet), 0n);
    await (await portal.getFunction("setWrongRecipient")()).wait();
    const bad = agents.create(user.id, "bad", {
      name: "Bad",
      symbol: "BAD",
      meta: "bafy",
    });
    await assert.rejects(async () => {
      for (let i = 0; i < 4; i++) await launcher.advance(bad.id);
    }, /recipient/);
  } finally {
    db.close();
    await transport.disconnect();
  }
});
