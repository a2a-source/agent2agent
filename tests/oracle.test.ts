import { test } from "node:test";
import assert from "node:assert/strict";
import { validateQuote, quoteCost } from "../src/price.js";
const now = Math.floor(Date.now() / 1000);
const q = {
  answer: "300000000000",
  decimals: 8,
  roundId: "12",
  answeredInRound: "12",
  updatedAt: now,
  blockNumber: 10,
  blockHash: "0xabc",
  chainId: 97,
  feed: "0xfeed",
  observedAt: Date.now(),
};
test("oracle quote uses exact integer ceiling and rejects invalid or stale rounds", () => {
  assert.equal(quoteCost(q), 3333333333334n);
  validateQuote(q, 3600);
  for (const change of [
    { answer: "0" },
    { answer: "-1" },
    { updatedAt: now - 3601 },
    { updatedAt: now + 60 },
    { answeredInRound: "11" },
    { roundId: "0" },
    { decimals: 37 },
  ])
    assert.throws(() => validateQuote({ ...q, ...change }, 3600));
});
import { Interface, type JsonRpcProvider } from "ethers";
import { ChainlinkPrice } from "../src/price.js";
test("Chainlink reader rejects wrong network/feed, stale chain and reorg", async () => {
  const abi = new Interface([
    "function decimals() view returns(uint8)",
    "function description() view returns(string)",
    "function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)",
  ]);
  let chainId = 97n,
    description = "BNB / USD",
    reorg = false,
    stale = false,
    reads = 0;
  const provider = {
    getNetwork: async () => ({ chainId }),
    getBlockNumber: async () => 100,
    getBlock: async () => ({
      number: 88,
      hash: reorg && ++reads > 1 ? "0xdef" : "0xabc",
      timestamp: now - (stale ? 200 : 0),
    }),
    call: async (tx: any) => {
      const name = abi.parseTransaction(tx)!.name;
      return abi.encodeFunctionResult(
        name,
        name === "decimals"
          ? [8]
          : name === "description"
            ? [description]
            : [12, 300000000000n, now, now, 12],
      );
    },
  } as unknown as JsonRpcProvider;
  const source = new ChainlinkPrice(
    provider,
    97,
    "0x2514895c72f50D8bd4B4F9b1110F0D6bD2c97526",
    3900,
    12,
  );
  assert.equal((await source.quote()).blockNumber, 88);
  chainId = 56n;
  await assert.rejects(source.quote(), /oracle/);
  chainId = 97n;
  description = "ETH / USD";
  await assert.rejects(source.quote(), /oracle/);
  description = "BNB / USD";
  stale = true;
  await assert.rejects(source.quote(), /oracle/);
  stale = false;
  reorg = true;
  await assert.rejects(source.quote(), /oracle/);
});
