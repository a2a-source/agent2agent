import { Wallet } from "ethers";
import {
  contextSchema,
  portfolioSnapshot,
  evidence,
  type ResearchAsset,
  type ResearchTestnetProfile,
} from "../../src/research-context.js";
import { hash } from "../../src/protocol.js";
import { signingMessage } from "../../src/qsp.js";
import { confirmationMessage } from "../../src/confirmation.js";
export const assets = [
  {
    symbol: "BTCB",
    address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
    decimals: 18,
    marketSymbol: "BTCUSDT",
  },
  {
    symbol: "ETH",
    address: "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    decimals: 18,
    marketSymbol: "ETHUSDT",
  },
  {
    symbol: "WBNB",
    address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    decimals: 18,
    marketSymbol: "BNBUSDT",
  },
];
export async function stableFixture(
  epochId = "1",
  profile?: {
    chainId: 97;
    assets: ResearchAsset[];
    testnetProfile: ResearchTestnetProfile;
  },
  timing?: { now: number; maxAgeMs?: number; validForMs?: number },
) {
  const now = timing?.now ?? 1000;
  const maxAgeMs = timing ? (timing.maxAgeMs ?? 600000) : 500;
  const validForMs = timing ? (timing.validForMs ?? 600000) : 1000;
  const deadline = timing ? now + validForMs : 1400;
  const chainId = profile?.chainId ?? 56;
  const fixtureAssets = profile?.assets ?? assets;
  const wallets = [
    Wallet.createRandom(),
    Wallet.createRandom(),
    Wallet.createRandom(),
  ];
  const committee = wallets.map((w, i) => ({
    id: `a${i}`,
    wallet: w.address,
    stake: "300000000000000000",
    compute: "1000",
  }));
  const proofs = fixtureAssets.map((a) =>
    evidence("market", `https://example.com/${a.symbol}`, now, {
      asset: a.address,
    }),
  );
  const pools = fixtureAssets.map((a) =>
    evidence("dex", `https://example.com/pool/${a.symbol}`, now, {
      asset: a.address,
    }),
  );
  const context = contextSchema.parse({
    version: "research-context/1",
    at: now,
    chainId,
    universe: fixtureAssets,
    ...(profile ? { testnetProfile: profile.testnetProfile } : {}),
    portfolio: portfolioSnapshot(
      fixtureAssets.map((a) => ({
        ...a,
        quantity: "0",
        priceMicros: "100000000",
        costMicros: null,
      })),
      true,
    ),
    portfolioIdentity: {
      wallet: wallets[0]!.address,
      scope: "CONFIGURED_ASSETS_AND_NATIVE",
      blockNumber: 1,
      blockHash: "fixture",
      nativeBalanceWei: "0",
      gasReserveWei: "0",
      stakeExcluded: true,
    },
    markets: fixtureAssets.map((a, i) => ({
      ...a,
      priceMicros: "100000000",
      asOf: now,
      changeBps: 0,
      volatilityBps: 0,
      smaMicros: "100000000",
      samples: 60,
      evidenceId: proofs[i]!.id,
    })),
    liquidity: fixtureAssets.map((a, i) => ({
      asset: a.address,
      pair: "fixture",
      dex: "fixture",
      liquidityUsd: 1000000,
      evidenceId: pools[i]!.id,
      observedAt: now,
      sourceTimestamp: null,
    })),
    news: [],
    evidence: [...proofs, ...pools],
    missing: [],
    previous: null,
    changes: {
      portfolioValueDeltaMicros: null,
      investmentReturnBps: null,
      returnMissing: "no history",
      positions: [],
      prices: [],
    },
    policy: {
      dataMaxAgeMs: maxAgeMs,
      maxAssetBps: 3000,
      maxTotalBps: 8000,
      validForMs,
      minLiquidityUsd: 1000000,
      maxSlippageBps: 100,
    },
  });
  const allocation = {
    version: "stable-network-allocation/1",
    scope: "NETWORK_MODEL_PORTFOLIO",
    reserve: "ALLOWLISTED_STABLECOINS",
    nativeBnb: "INCLUDED_IN_BNB_TARGET",
    targets: fixtureAssets.map((a, i) => ({
      asset: a.address,
      targetWeightBps: 2000,
      evidence: [proofs[i]!.id, pools[i]!.id],
      rationale: "research",
    })),
    limitations: ["reference only"],
  };
  const reports = [
    {
      role: "market",
      agent: "a1",
      contextHash: hash(context),
      summary: "research",
      recommendation: "allocation",
      uncertainty: "reference",
      missing: [],
      sources: [...proofs, ...pools].map((e) => e.url),
      evidenceIds: [...proofs, ...pools].map((e) => e.id),
      additionalEvidence: [],
    },
  ];
  const output: any = {
    version: "a2a-qsp/2",
    epoch: epochId,
    view: 0,
    master: "a0",
    committeeHash: hash(committee),
    configHash: "config",
    dataAt: now,
    createdAt: now,
    validUntil: now + validForMs,
    contextHash: hash(context),
    context,
    reports,
    masterSummary: {
      summary: "shared stable",
      decisions: [{ role: "market", decision: "ACCEPT", reason: "evidence" }],
      disagreements: [],
      stableNetworkAllocation: allocation,
    },
    signals: [],
    risks: ["reference"],
    executed: false,
  };
  const epoch: any = {
    id: epochId,
    slot: Number(epochId),
    term: 0,
    view: 0,
    master: "a0",
    committee,
    snapshotHash: "snapshot",
    configHash: "config",
    config: { termSlots: 7, committeeSize: 3, timeoutMs: 500 },
    deadline,
    status: "PUBLISHED",
    confirmationRequired: true,
    output,
  };
  const resign = async () => {
    epoch.signature = await wallets[0]!.signMessage(
      signingMessage(chainId, output),
    );
    const d = {
      version: "a2a-confirmation/1" as const,
      chainId,
      epoch: epochId,
      proposalHash: hash({ output, signature: epoch.signature }),
      committeeHash: hash(committee),
      configHash: "config",
      expiresAt: deadline,
    };
    epoch.confirmation = {
      ...d,
      votes: await Promise.all(
        wallets.map(async (w, i) => ({
          agent: `a${i}`,
          signature: await w.signMessage(confirmationMessage(d)),
        })),
      ),
      confirmedAt: now + 10,
    };
  };
  await resign();
  return { epoch, output, context, reports, allocation, resign };
}
