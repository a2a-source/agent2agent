import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import ganache from "ganache";
import {
  BrowserProvider,
  ContractFactory,
  Wallet,
  parseEther,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { compileContracts } from "../src/contracts.js";
import { Store } from "../src/store.js";
import { WalletVault } from "../src/wallet.js";
import { Agents } from "../src/agents.js";
import { Journal } from "../src/chain.js";
import { TaxSettlement } from "../src/tax-settlement.js";

test("settlement autonomously dispatches verified revenue, resumes without duplicates and respects spending bounds", async () => {
  const transport = ganache.provider({
    logging: { quiet: true },
    chain: { chainId: 97, hardfork: "shanghai" },
  });
  const p = new BrowserProvider(transport as any, undefined, {
    cacheTimeout: -1,
  });
  const db = new Store(":memory:");
  try {
    const signer = await p.getSigner(),
      operator = new Wallet(
        Object.values(transport.getInitialAccounts())[0]!.secretKey,
      );
    const artifacts = compileContracts({
      "Settlement.sol": {
        content: `pragma solidity ^0.8.24;
 contract ToggleReceiver {bool public accepting;function allow() external {accepting=true;}receive() external payable{require(accepting);}}
 contract SettlementToken {address public taxProcessor; function set(address p) external {taxProcessor=p;}}
 contract SettlementProcessor {address public taxToken; address public marketAddress; uint256 public marketQuoteBalance; constructor(address t,address m){taxToken=t;marketAddress=m;} function weth() external pure returns(address){return address(1);} function getQuoteToken() external pure returns(address){return address(1);} receive() external payable{marketQuoteBalance+=msg.value;} function change(address m) external {marketAddress=m;} function dispatch() external {uint256 n=marketQuoteBalance;marketQuoteBalance=0;(bool ok,)=marketAddress.call{value:n}("");require(ok);}}
 `,
      },
    });
    async function deploy(name: string, args: any[] = []) {
      const a = artifacts[name]!;
      const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(
        ...args,
      );
      await c.waitForDeployment();
      return c as any;
    }
    const factory = await deploy("SplitterFactory", [operator.address]);
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const vault = new WalletVault(
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "v1",
    );
    const agents = new Agents(db, vault);
    const a = agents.create("owner", "1", {
      name: "Test",
      symbol: "TEST",
      meta: "cid",
    });
    const key = keccak256(toUtf8Bytes(a.id));
    await (await factory.create(key, a.wallet)).wait();
    const splitter = await factory.predict(key, a.wallet);
    const token = await deploy("SettlementToken");
    const processor = await deploy("SettlementProcessor", [
      await token.getAddress(),
      splitter,
    ]);
    await (await token.set(await processor.getAddress())).wait();
    agents.update(a.id, {
      launch: "CONFIRMED",
      token: await token.getAddress(),
      splitter,
    });
    const deployment = await token.deploymentTransaction().wait();
    db.put("transaction", `launch:${a.id}`, {
      id: `launch:${a.id}`,
      sender: operator.address,
      hash: deployment.hash,
      state: "CONFIRMED",
      block: deployment.blockNumber,
    });
    const count = () =>
      db.all<any>("transaction").filter((t) => t.id.startsWith("tax:")).length;
    const journal = new Journal(db, p, 97, true);
    const cfg = {
      factory: await factory.getAddress(),
      confirmations: 1,
      minRevenueWei: "0",
      maxFeeWei: parseEther("0.001").toString(),
      dailyBudgetWei: parseEther("0.002").toString(),
      gasReserveWei: "0",
      intervalMs: 1,
    };
    const settlement = new TaxSettlement(agents, journal, operator, cfg);
    await settlement.tick();
    assert.equal(count(), 0, "no empty dispatch");
    await (
      await signer.sendTransaction({
        to: await processor.getAddress(),
        value: parseEther("0.1"),
      })
    ).wait();
    await settlement.tick();
    await settlement.tick();
    assert.equal(await processor.marketQuoteBalance(), 0n);
    assert.equal(await p.getBalance(a.wallet), parseEther("0.07"));
    assert.equal(count(), 1);
    await new TaxSettlement(agents, journal, operator, cfg).tick();
    assert.equal(count(), 1, "restart must not repeat completed dispatch");
    await (await processor.change(operator.address)).wait();
    await (
      await signer.sendTransaction({
        to: await processor.getAddress(),
        value: parseEther("0.1"),
      })
    ).wait();
    await settlement.tick();
    assert.equal(count(), 1, "wrong binding fails closed");
    await (await processor.change(splitter)).wait();
    const limited = new TaxSettlement(agents, journal, operator, {
      ...cfg,
      dailyBudgetWei: "1",
    });
    await limited.tick();
    assert.equal(count(), 1, "daily cap prevents signing");
    const receiver = await deploy("ToggleReceiver");
    const b = agents.create("owner", "2", {
      name: "Second",
      symbol: "TWO",
      meta: "cid",
    });
    agents.db.put("agent", b.id, { ...b, wallet: await receiver.getAddress() });
    const key2 = keccak256(toUtf8Bytes(b.id));
    await (await factory.create(key2, await receiver.getAddress())).wait();
    const split2 = await factory.predict(key2, await receiver.getAddress());
    const token2 = await deploy("SettlementToken");
    const proc2 = await deploy("SettlementProcessor", [
      await token2.getAddress(),
      split2,
    ]);
    await (await token2.set(await proc2.getAddress())).wait();
    agents.update(b.id, {
      launch: "CONFIRMED",
      token: await token2.getAddress(),
      splitter: split2,
    });
    const receipt2 = await token2.deploymentTransaction().wait();
    db.put("transaction", `launch:${b.id}`, {
      id: `launch:${b.id}`,
      sender: operator.address,
      hash: receipt2.hash,
      state: "CONFIRMED",
      block: receipt2.blockNumber,
    });
    await (await processor.change(operator.address)).wait(); // First Agent fails validation; second must still settle.
    const recovery = new TaxSettlement(agents, journal, operator, {
      ...cfg,
      dailyBudgetWei: parseEther("0.02").toString(),
    });
    await (
      await signer.sendTransaction({
        to: await proc2.getAddress(),
        value: parseEther("0.1"),
      })
    ).wait();
    await recovery.tick();
    await recovery.tick();
    const splitContract = new (await import("ethers")).Contract(
      split2,
      artifacts.RevenueSplitter!.abi,
      p,
    );
    assert.equal(
      await splitContract.getFunction("agentPending")(),
      parseEther("0.07"),
    );
    await (await receiver.allow()).wait();
    await recovery.tick();
    await recovery.tick();
    assert.equal(await splitContract.getFunction("agentPending")(), 0n);
    assert.equal(
      await p.getBalance(await receiver.getAddress()),
      parseEther("0.07"),
    );
    assert.equal(
      count(),
      3,
      "one dispatch and one flush recover the failed recipient",
    );
  } finally {
    db.close();
    p.destroy();
    await transport.disconnect();
  }
});
