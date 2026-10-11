import test from "node:test";
import assert from "node:assert/strict";
import {
  contextSchema,
  portfolioSnapshot,
  promptSnapshot,
  researchAssetRegistryHash,
} from "../src/research-context.js";
import { researchFacts, researchChecks } from "../src/research-facts.js";
import { contextTools } from "../src/research-data.js";
import { hash } from "../src/protocol.js";
import { stableFixture } from "./helpers/stable-qsp.js";
const native = "0x0000000000000000000000000000000000000000";
const assets = [
  {
    symbol: "QBTC",
    address: "0xf3e87e6eb773ab52f7005a46d077403b90bf9273",
    decimals: 18,
    marketSymbol: "BTCUSDT",
  },
  {
    symbol: "QETH",
    address: "0xaf45bf26ec0551c683037729cecf6111dc89a60b",
    decimals: 18,
    marketSymbol: "ETHUSDT",
  },
  {
    symbol: "WBNB",
    address: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
    decimals: 18,
    marketSymbol: "BNBUSDT",
  },
];
async function context8368() {
  const { context } = await stableFixture();
  return contextSchema.parse({
    ...context,
    chainId: 97,
    universe: assets,
    testnetProfile: {
      kind: "bsc97-test-assets/1",
      registryHash: researchAssetRegistryHash(assets),
    },
    portfolio: portfolioSnapshot(
      [
        ...assets.map((a, i) => ({
          ...a,
          quantity: ["9381550", "106281540", "0"][i]!,
          priceMicros: ["100000000000", "3000000000", "600000000"][i]!,
          costMicros: null,
        })),
        {
          symbol: "QUSD",
          address: "0x50ce37d163dcb333c5b164e6ac00e152ead7de9b",
          decimals: 18,
          marketSymbol: "USDTUSDT",
          quantity: "971423657563372744432",
          priceMicros: "1000000",
          costMicros: null,
        },
        {
          symbol: "BNB",
          address: native,
          decimals: 18,
          marketSymbol: "BNBUSDT",
          quantity: "48913484950000000",
          priceMicros: "600000000",
          costMicros: null,
        },
      ],
      true,
    ),
    portfolioIdentity: {
      ...context.portfolioIdentity,
      nativeBalanceWei: "49913484950000000",
      gasReserveWei: "1000000000000000",
    },
    liquidity: [
      {
        ...context.liquidity[2],
        asset: assets[2]!.address,
        liquidityUsd: 95842,
      },
    ],
    policy: { ...context.policy, minLiquidityUsd: 1000000 },
  });
}
test("8368 prose quantities, full stable holdings, gas and canonical native mechanics are explicit", async () => {
  const c = await context8368();
  const brief = promptSnapshot(c).researchSemanticsBrief;
  assert.equal(
    brief.holdings.find((p) => p.symbol === "QBTC")!.quantity,
    "0.00000000000938155",
  );
  assert.equal(
    brief.holdings.find((p) => p.symbol === "QETH")!.quantity,
    "0.00000000010628154",
  );
  const stable = brief.holdings.find((p) => p.symbol === "QUSD")!;
  assert.equal(stable.quantity, "971.423657563372744432");
  assert.equal(stable.valueUSDT, "971.423657");
  assert.equal(stable.inResearchUniverse, false);
  assert(Number(stable.weightPercent) > 97);
  assert.equal(brief.gas.gasReserveWei, "1000000000000000");
  assert.equal(brief.gas.gasReserveBNB, "0.001");
  assert.equal(brief.gas.nativeBalanceBNB, "0.04991348495");
  assert.equal(brief.gas.snapshotNativeFundingBNB, "0.04891348495");
  assert.equal(
    brief.holdings.find((p) => p.symbol === "WBNB")!.mechanism,
    "CANONICAL_NATIVE_WRAPPER",
  );
  assert.match(brief.mechanismGuidance, /deposit\/withdraw/);
  assert.match(brief.bnbBucketGuidance, /zero token.*native/i);
  assert.equal(brief.execution.status, "NOT_VERIFIED");
  assert.equal(brief.execution.pools[0]!.meetsResearchMinimum, false);
  assert.match(brief.execution.guidance, /not an executable/);
});
test("all role inputs and role snapshot tools see the same brief without changing frozen facts or hashes", async () => {
  const c = await context8368(),
    before = hash(c),
    facts = hash(researchFacts(c)),
    checks = hash(researchChecks(c));
  for (const role of [
    "positions",
    "market",
    "news",
    "macro",
    "onchain",
    "risk",
  ]) {
    const p = promptSnapshot(c, role);
    assert.equal(
      p.researchSemanticsBrief.version,
      "research-semantics-brief/1",
    );
    const tool = contextTools(c, role).find(
      (t) => t.name === "research_snapshot",
    )!;
    const output = (await tool.run({})) as { data: typeof p };
    assert.deepEqual(
      output.data.researchSemanticsBrief,
      p.researchSemanticsBrief,
    );
  }
  assert.equal(hash(c), before);
  assert.equal(hash(researchFacts(c)), facts);
  assert.equal(hash(researchChecks(c)), checks);
  assert(!Object.hasOwn(c, "researchSemanticsBrief"));
});
test("zero reserve is known, unavailable funding remains unknown and symbols cannot impersonate canonical WBNB", async () => {
  const c = await context8368();
  c.portfolioIdentity.gasReserveWei = "0";
  c.portfolioIdentity.nativeBalanceWei = null;
  c.portfolio.status = "UNKNOWN";
  c.portfolio.positions[2]!.address = "0x" + "11".repeat(20);
  const b = promptSnapshot(c).researchSemanticsBrief;
  assert.equal(b.gas.gasReserveBNB, "0.0");
  assert.equal(b.gas.nativeBalanceBNB, null);
  assert.equal(b.gas.snapshotNativeFundingBNB, null);
  assert.equal(b.holdings[2]!.mechanism, "UNVERIFIED");
  assert.equal(b.holdings[0]!.quantity, null);
  assert.equal(b.holdings[0]!.weightPercent, null);
});

test("canonical wrapper recognition is address and chain bound, including mainnet and legacy qBNB", async () => {
  const c = await context8368();
  c.portfolio.positions[2]!.symbol = "QBNB";
  assert.equal(
    promptSnapshot(c).researchSemanticsBrief.holdings[2]!.mechanism,
    "CANONICAL_NATIVE_WRAPPER",
  );
  c.portfolio.positions[2]!.address =
    "0xd1dfd4ec26fe763277cf2dbd1232db2b4050820a";
  assert.equal(
    promptSnapshot(c).researchSemanticsBrief.holdings[2]!.mechanism,
    "UNVERIFIED",
  );
  c.chainId = 56;
  c.portfolio.positions[2]!.address =
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  assert.equal(
    promptSnapshot(c).researchSemanticsBrief.holdings[2]!.mechanism,
    "CANONICAL_NATIVE_WRAPPER",
  );
  c.chainId = 97;
  assert.equal(
    promptSnapshot(c).researchSemanticsBrief.holdings[2]!.mechanism,
    "UNVERIFIED",
  );
});
