import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertResearchAssets,
  contextSchema,
} from "../src/research-context.js";
import { hash } from "../src/protocol.js";
import { loadConfig } from "../src/config.js";
import { stableFixture } from "./helpers/stable-qsp.js";
import { qspV2Schema } from "../src/qsp-v2.js";
import { validateStableNetworkAllocation } from "../src/stable-network-allocation.js";
const assets = [
  {
    symbol: "TBNB",
    address: "0x0000000000000000000000000000000000000091",
    decimals: 18,
    marketSymbol: "BNBUSDT",
  },
  {
    symbol: "TBTC",
    address: "0x0000000000000000000000000000000000000092",
    decimals: 8,
    marketSymbol: "BTCUSDT",
  },
  {
    symbol: "TETH",
    address: "0x0000000000000000000000000000000000000093",
    decimals: 18,
    marketSymbol: "ETHUSDT",
  },
];
const profile = {
  kind: "bsc97-test-assets/1" as const,
  registryHash: hash(assets),
};
test("BSC97 accepts only an explicit complete test asset commitment without relaxing mainnet", () => {
  assert.doesNotThrow(() => assertResearchAssets(97, assets, profile));
  assert.throws(() => assertResearchAssets(97, assets));
  assert.throws(() => assertResearchAssets(56, assets, profile));
  assert.throws(() => assertResearchAssets(1, assets, profile));
  for (const changed of [
    assets.slice(1),
    [...assets.slice(0, 2), assets[0]!],
    assets.map((a, i) => (i ? a : { ...a, decimals: 6 })),
  ]) {
    assert.throws(() => assertResearchAssets(97, changed, profile));
  }
  for (const incomplete of [
    assets.slice(1),
    [...assets.slice(0, 2), assets[0]!],
  ]) {
    assert.throws(() =>
      assertResearchAssets(97, incomplete, {
        ...profile,
        registryHash: hash(incomplete),
      }),
    );
  }
  assertResearchAssets(56, loadConfig().research.assets);
});
test("config preserves testnet profile and rejects absent or mismatching commitments", () => {
  const dir = mkdtempSync(join(tmpdir(), "research-testnet-"));
  const path = join(dir, "config.json");
  try {
    const write = (testnetProfile?: unknown) =>
      writeFileSync(
        path,
        JSON.stringify({ research: { chainId: 97, assets, testnetProfile } }),
      );
    write(profile);
    assert.deepEqual(
      (loadConfig(path).research as any).testnetProfile,
      profile,
    );
    write();
    assert.throws(() => loadConfig(path));
    write({ ...profile, registryHash: hash([]) });
    assert.throws(() => loadConfig(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("QSP and stable allocation validate the signed testnet profile and reject tampering", async () => {
  const f = await stableFixture();
  const byMarket = new Map(assets.map((a) => [a.marketSymbol, a]));
  const oldAddresses = new Map(
    f.context.universe.map((a) => [a.address, byMarket.get(a.marketSymbol)!]),
  );
  const context: any = {
    ...f.context,
    chainId: 97,
    universe: assets,
    testnetProfile: profile,
    portfolio: {
      ...f.context.portfolio,
      positions: f.context.portfolio.positions.map((p) => ({
        ...p,
        ...byMarket.get(p.marketSymbol)!,
      })),
    },
    markets: f.context.markets.map((m) => ({
      ...m,
      ...byMarket.get(m.marketSymbol)!,
    })),
    liquidity: f.context.liquidity.map((l) => ({
      ...l,
      asset: oldAddresses.get(l.asset)!.address,
    })),
  };
  const allocation = {
    ...f.allocation,
    targets: f.allocation.targets.map((t) => ({
      ...t,
      asset: oldAddresses.get(t.asset)!.address,
    })),
  };
  const reports = f.reports.map((r) => ({ ...r, contextHash: hash(context) }));
  const output = {
    ...f.output,
    context,
    contextHash: hash(context),
    reports,
    masterSummary: {
      ...f.output.masterSummary,
      stableNetworkAllocation: allocation,
    },
  };
  assert.deepEqual(
    (contextSchema.parse(context) as any).testnetProfile,
    profile,
  );
  assert.deepEqual(
    validateStableNetworkAllocation(allocation, context, reports, 1100, 500)
      .targets,
    { BTC: 2000, ETH: 2000, BNB: 2000 },
  );
  assert.equal(qspV2Schema.parse(output).context.chainId, 97);
  for (const testnetProfile of [
    undefined,
    { ...profile, registryHash: hash([]) },
  ]) {
    const changed = { ...context, testnetProfile };
    assert.throws(() =>
      validateStableNetworkAllocation(allocation, changed, reports, 1100, 500),
    );
    assert.throws(() =>
      qspV2Schema.parse({
        ...output,
        context: changed,
        contextHash: hash(changed),
      }),
    );
  }
});

test("signed testnet fixture binds BSC97 assets and committee chain", async () => {
  const f = await stableFixture("2", {
    chainId: 97,
    assets,
    testnetProfile: profile,
  });
  assert.equal(f.context.chainId, 97);
  assert.deepEqual(f.context.universe, assets);
  assert.equal(f.epoch.confirmation.chainId, 97);
  assert.equal(qspV2Schema.parse(f.output).context.chainId, 97);
});

test("timed testnet fixture has fresh coherent evidence and certificate deadlines", async () => {
  const now = 1800000000000;
  const f = await stableFixture(
    "3",
    { chainId: 97, assets, testnetProfile: profile },
    { now },
  );
  assert.equal(f.context.at, now);
  assert.equal(f.output.validUntil, now + 600000);
  assert.equal(f.epoch.confirmation.expiresAt, now + 600000);
  assert.ok(f.context.evidence.every((e) => e.asOf === now));
  assert.equal(qspV2Schema.parse(f.output).dataAt, now);
});
