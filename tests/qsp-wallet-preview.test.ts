import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { previewQspForWallet } from "../src/qsp-wallet-preview.js";
import { qspV2Schema } from "../src/qsp-v2.js";
import {
  contextSchema,
  evidence,
  portfolioSnapshot,
} from "../src/research-context.js";
import { hash } from "../src/protocol.js";
import { signingMessage } from "../src/qsp.js";
import {
  confirmationMessage,
  verifyPublishedEpoch,
} from "../src/confirmation.js";
const asset = {
  symbol: "ETH",
  address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
  decimals: 18,
  marketSymbol: "ETHUSDT",
};
async function fixture(
  mode: "active" | "absent" | "null" = "active",
  poolAt = 1000,
) {
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
  const proof = evidence("market", "https://example.com/market", 1000, {
    price: "100000000",
  });
  const pool = evidence("dex", "https://example.com/pool", poolAt, {
    liquidityUsd: 1000000,
  });
  const context = contextSchema.parse({
    version: "research-context/1",
    at: 1000,
    chainId: 56,
    universe: [asset],
    portfolio: portfolioSnapshot(
      [{ ...asset, quantity: "0", priceMicros: "100000000", costMicros: null }],
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
    markets: [
      {
        ...asset,
        priceMicros: "100000000",
        asOf: 1000,
        changeBps: 0,
        volatilityBps: 0,
        smaMicros: "100000000",
        samples: 60,
        evidenceId: proof.id,
      },
    ],
    liquidity: [
      {
        asset: asset.address,
        pair: "fixture",
        dex: "fixture",
        liquidityUsd: 1000000,
        evidenceId: pool.id,
        observedAt: poolAt,
        sourceTimestamp: null,
      },
    ],
    news: [],
    evidence: [proof, pool],
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
      dataMaxAgeMs: 500,
      maxAssetBps: 3000,
      maxTotalBps: 8000,
      validForMs: 1000,
      minLiquidityUsd: 1000000,
      maxSlippageBps: 100,
    },
  });
  const output: any = qspV2Schema.parse({
    version: "a2a-qsp/2",
    epoch: "1",
    view: 0,
    master: "a0",
    committeeHash: hash(committee),
    configHash: "config",
    dataAt: 1000,
    createdAt: 1000,
    validUntil: 2000,
    contextHash: hash(context),
    context,
    reports: [
      {
        role: "market",
        agent: "a1",
        contextHash: hash(context),
        summary: "market research",
        recommendation: "model allocation",
        uncertainty: "no execution quote",
        missing: [],
        sources: [proof.url, pool.url],
        evidenceIds: [proof.id, pool.id],
        additionalEvidence: [],
      },
    ],
    masterSummary: {
      summary: "shared model",
      decisions: [{ role: "market", decision: "ACCEPT", reason: "evidence" }],
      disagreements: [],
      networkAllocation: {
        version: "network-allocation/1",
        scope: "NETWORK_MODEL_PORTFOLIO",
        targets: [
          {
            asset: asset.address,
            targetWeightBps: 2000,
            evidence: [proof.id, pool.id],
            rationale: "market context",
          },
        ],
        limitations: ["no executable quote"],
      },
    },
    signals: [],
    risks: ["native is volatile"],
    executed: false,
  });
  if (mode === "absent") delete output.masterSummary.networkAllocation;
  if (mode === "null") output.masterSummary.networkAllocation = null;
  const signature = await wallets[0]!.signMessage(signingMessage(56, output));
  const descriptor = {
    version: "a2a-confirmation/1" as const,
    chainId: 56,
    epoch: "1",
    proposalHash: hash({ output, signature }),
    committeeHash: hash(committee),
    configHash: "config",
    expiresAt: 1400,
  };
  const votes = await Promise.all(
    wallets.map(async (w, i) => ({
      agent: `a${i}`,
      signature: await w.signMessage(confirmationMessage(descriptor)),
    })),
  );
  const epoch: any = {
    id: "1",
    slot: 1,
    term: 0,
    view: 0,
    master: "a0",
    committee,
    snapshotHash: "snapshot",
    configHash: "config",
    config: { termSlots: 7, committeeSize: 3, timeoutMs: 500 },
    deadline: 1400,
    status: "PUBLISHED",
    confirmationRequired: true,
    output,
    signature,
    confirmation: { ...descriptor, votes, confirmedAt: 1010 },
  };
  const snapshot: any = {
    agent: "wallet-a",
    wallet: wallets[1]!.address,
    chainId: 56,
    observedAt: 1050,
    nativeBalanceWei: "10000000000000000000",
    nativePriceMicros: "100000000",
    gasReserveWei: "0",
    pendingNativeWei: "0",
    positions: [
      {
        asset: asset.address,
        decimals: 18,
        balance: "0",
        pending: "0",
        priceMicros: "100000000",
      },
    ],
  };
  const policy = {
    allowedAssets: [asset.address],
    maxAssetBps: 3000,
    maxTotalBps: 8000,
    maxTurnoverBps: 10000,
    maxSnapshotAgeMs: 500,
  };
  return { epoch, snapshot, policy };
}
test("committee-confirmed shared targets produce distinct wallet previews with source binding", async () => {
  const f = await fixture();
  assert(verifyPublishedEpoch(56, f.epoch));
  const a = previewQspForWallet(f.epoch, f.snapshot, f.policy, 56, 1100);
  const second = {
    ...f.snapshot,
    agent: "wallet-b",
    wallet: Wallet.createRandom().address,
    nativeBalanceWei: "6000000000000000000",
    positions: [{ ...f.snapshot.positions[0], balance: "4000000000000000000" }],
  };
  const b = previewQspForWallet(f.epoch, second, f.policy, 56, 1100);
  assert.equal(a.items[0]?.side, "BUY");
  assert.equal(b.items[0]?.side, "SELL");
  assert.equal(a.source.qspHash, hash(f.epoch.output));
  assert.equal(b.source.qspHash, a.source.qspHash);
  assert.notEqual(a.id, b.id);
  assert.equal(a.executed, false);
  assert.equal(a.validUntil, 1500);
});
test("consumer rejects tampering, missing confirmation, wrong chain, expiration and legacy inference", async () => {
  const f = await fixture();
  for (const mutate of [
    (x: any) =>
      (x.epoch.output.masterSummary.networkAllocation.targets[0].targetWeightBps = 1000),
    (x: any) => (x.epoch.confirmationRequired = false),
    (x: any) => delete x.epoch.confirmation,
    (x: any) => x.epoch.confirmation.votes.pop(),
    (x: any) => delete x.epoch.output.masterSummary.networkAllocation,
    (x: any) => (x.epoch.output.masterSummary.networkAllocation = null),
    (x: any) => (x.snapshot.chainId = 97),
    (x: any) => (x.snapshot.positions[0].decimals = 6),
    (x: any) => (x.policy.maxAssetBps = 1999),
  ]) {
    const x = structuredClone(f);
    mutate(x);
    assert.throws(() =>
      previewQspForWallet(x.epoch, x.snapshot, x.policy, 56, 1100),
    );
  }
  assert.throws(() =>
    previewQspForWallet(f.epoch, f.snapshot, f.policy, 97, 1100),
  );
  assert.throws(
    () =>
      previewQspForWallet(
        f.epoch,
        { ...f.snapshot, observedAt: 1500 },
        f.policy,
        56,
        1500,
      ),
    /expired/,
  );
  assert.throws(
    () =>
      previewQspForWallet(
        f.epoch,
        { ...f.snapshot, observedAt: 2000 },
        f.policy,
        56,
        2000,
      ),
    /expired/,
  );
});

test("authentic old or null-allocation packages cannot be inferred into network targets", async () => {
  for (const mode of ["absent", "null"] as const) {
    const f = await fixture(mode);
    assert(verifyPublishedEpoch(56, f.epoch));
    assert.throws(
      () => previewQspForWallet(f.epoch, f.snapshot, f.policy, 56, 1100),
      /no explicit network allocation/,
    );
  }
});

test("preview validity cannot outlive its cited liquidity evidence", async () => {
  const f = await fixture("active", 700);
  const p = previewQspForWallet(f.epoch, f.snapshot, f.policy, 56, 1100);
  assert.equal(p.validUntil, 1200);
  assert.throws(() =>
    previewQspForWallet(f.epoch, f.snapshot, f.policy, 56, 1200),
  );
});
