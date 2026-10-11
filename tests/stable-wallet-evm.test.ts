import test from "node:test";
import assert from "node:assert/strict";
import ganache from "ganache";
import solc from "solc";
import { BrowserProvider, ContractFactory, Wallet } from "ethers";
import { Store } from "../src/store.js";
import {
  EthersPortfolioReader,
  PortfolioCollector,
} from "../src/portfolio-snapshot.js";
import { StableWalletPlanner } from "../src/stable-wallet-plan.js";

test("real local EVM balances/oracles drive three durable stable-wallet rounds", async () => {
  const transport = ganache.provider({
    logging: { quiet: true },
    chain: { chainId: 1337, hardfork: "shanghai" },
  });
  const db = new Store(":memory:");
  const provider = new BrowserProvider(transport as any, undefined, {
    cacheTimeout: -1,
  });
  try {
    const compiled = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: "Solidity",
          sources: {
            "Fixture.sol": {
              content: `pragma solidity ^0.8.20;
 contract Fixture { string public description; int256 public answer; uint256 public balance; uint8 public decimals=8;
 constructor(string memory d,int256 p,uint256 b){description=d;answer=p;balance=b;}
 function balanceOf(address) external view returns(uint256){return balance;}
 function setBalance(uint256 b) external {balance=b;}
 function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80){return (1,answer,block.timestamp,block.timestamp,1);}
 }`,
            },
          },
          settings: {
            evmVersion: "shanghai",
            outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
          },
        }),
      ),
    );
    const artifact = compiled.contracts["Fixture.sol"].Fixture;
    const signer = await provider.getSigner();
    const deployed = [];
    for (const [name, price, balance] of [
      ["BNB", 100, 0],
      ["BTC", 1000, 0],
      ["ETH", 100, 0],
      ["USDT", 1, 1000],
    ] as const) {
      const c = await new ContractFactory(
        artifact.abi,
        artifact.evm.bytecode.object,
        signer,
      ).deploy(
        `${name} / USD`,
        BigInt(price) * 100000000n,
        BigInt(balance) * 100000000n,
      );
      await c.waitForDeployment();
      deployed.push(c);
    }
    const addresses = await Promise.all(
      deployed.map((c) => c.getAddress().then((a) => a.toLowerCase())),
    );
    const assets = [
      {
        asset: "native",
        bucket: "BNB",
        decimals: 18,
        feed: addresses[0]!,
        description: "BNB / USD",
      },
      ...addresses.map((a, i) => ({
        asset: a,
        bucket: ["BNB", "BTC", "ETH", "STABLE"][i]!,
        decimals: 8,
        feed: a,
        description: ["BNB / USD", "BTC / USD", "ETH / USD", "USDT / USD"][i]!,
      })),
    ];
    const registry = {
      chainId: 1337,
      confirmations: 1,
      maxBlockAgeMs: 60000,
      maxPriceAgeMs: 60000,
      assets,
    };
    const req = {
      id: "round-1",
      agent: "a",
      wallet: Wallet.createRandom().address,
      gasReserveWei: "0",
      reservationSource: "local-evm-no-pending",
      reserved: Object.fromEntries(assets.map((a) => [a.asset, "0"])),
    };
    const collector = new PortfolioCollector(
      db,
      new EthersPortfolioReader(provider),
      registry,
    );
    const planner = new StableWalletPlanner(db);
    const run = async (round: number, zero = false) => {
      await provider.send("evm_mine", []);
      const snapshot = await collector.collect({
        ...req,
        id: `round-${round}`,
      });
      const now = Date.now();
      return planner.plan(
        snapshot.id,
        {
          version: "stable-allocation-preview/1",
          epoch: `round-${round}`,
          chainId: 1337,
          createdAt: now,
          validUntil: now + 30000,
          targets: zero
            ? { BTC: 0, ETH: 0, BNB: 0 }
            : { BTC: 2000, ETH: 2000, BNB: 2000 },
        },
        true,
        now,
      );
    };
    const buy = await run(1);
    assert.equal(buy.phase, "ACCUMULATE");
    assert.equal(buy.orders.length, 3);
    await (await deployed[1]!.getFunction("setBalance")(1000000000n)).wait();
    const sell = await run(2);
    assert.equal(sell.phase, "REDUCE_FIRST");
    assert.equal(sell.orders[0]!.bucket, "BTC");
    assert.equal(sell.orders[0]!.side, "SELL");
    await (await deployed[1]!.getFunction("setBalance")(0)).wait();
    const hold = await run(3, true);
    assert.equal(hold.status, "NO_ACTION");
    assert.equal(db.all("portfolio-snapshot").length, 3);
    assert.equal(db.all("stable-wallet-plan").length, 3);
    assert.equal(db.all("portfolio-observation").length, 15);
  } finally {
    db.close();
    provider.destroy();
    await transport.disconnect();
  }
});
