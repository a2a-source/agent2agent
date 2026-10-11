import test from "node:test";
import assert from "node:assert/strict";
import {
  contextSchema,
  portfolioSnapshot,
  promptSnapshot,
} from "../src/research-context.js";
import {
  researchChecks,
  researchFacts,
  verifyResearchChecks,
} from "../src/research-facts.js";
import { allocationReferenceBrief } from "../src/allocation-reference.js";
import { hash } from "../src/protocol.js";
import { stableFixture } from "./helpers/stable-qsp.js";
const native = "0x0000000000000000000000000000000000000000";
async function fixture() {
  const { context } = await stableFixture();
  const universe = context.universe.map((a) => ({ ...a, decimals: 6 }));
  const bnb = universe.find((a) => a.marketSymbol === "BNBUSDT")!;
  const portfolio = portfolioSnapshot(
    [
      ...universe.map((a) => ({
        ...a,
        quantity:
          a.marketSymbol === "BNBUSDT"
            ? "56824038"
            : a.marketSymbol === "BTCUSDT"
              ? "942031075"
              : "0",
        priceMicros: "1000000",
        costMicros: null,
      })),
      {
        ...bnb,
        symbol: "BNB",
        address: native,
        quantity: "29352444",
        priceMicros: "1000000",
        costMicros: null,
      },
    ],
    true,
  );
  return contextSchema.parse({
    ...context,
    universe,
    portfolio,
    policy: { ...context.policy, maxAssetBps: 3000, maxTotalBps: 8000 },
  });
}
test("8364 reference amounts combine before rounding and remain descriptive common-model observations", async () => {
  const c = await fixture(),
    brief = allocationReferenceBrief(c);
  assert.equal(brief.portfolioValueMicros, "1028207557");
  assert.equal(brief.configuredBnbToken.valueMicros, "56824038");
  assert.equal(brief.configuredBnbToken.weightBps, 552);
  assert.equal(brief.nativeBnb.valueMicros, "29352444");
  assert.equal(brief.nativeBnb.weightBps, 285);
  assert.equal(brief.combinedBnb.valueMicros, "86176482");
  assert.equal(brief.combinedBnb.weightBps, 838);
  assert.equal(brief.combinedBnb.status, "KNOWN");
  assert.equal(brief.currency, "micro-USDT");
  assert.equal(brief.valuation, "REFERENCE_MARK");
  assert.match(brief.scope, /GAS_RESERVE_EXCLUDED/);
  assert.deepEqual(brief.stableCommonModelCeilingsBps, {
    perAsset: 2000,
    total: 6000,
  });
  assert.match(brief.guidance, /not recommended targets/);
  assert.match(brief.targetScopes.legacyConfiguredToken, /TOKEN_ONLY/);
  assert.match(brief.targetScopes.stableReserveBnb, /NATIVE_PLUS/);
});
test("native-only exposure requires an explicitly known zero token, and weights never invent missing values", async () => {
  const c = await fixture(),
    token = c.portfolio.positions.find(
      (p) => p.address.toLowerCase() === c.universe[2]!.address.toLowerCase(),
    )!;
  token.quantity = "0";
  token.valueMicros = "0";
  c.portfolio.valueMicros = "29352444";
  const brief = allocationReferenceBrief(c);
  assert.equal(brief.configuredBnbToken.weightBps, 0);
  assert.equal(brief.nativeBnb.weightBps, 10000);
  assert.equal(brief.combinedBnb.weightBps, 10000);
  for (const kind of [
    "missing-native",
    "missing-token",
    "unknown-value",
    "unknown-portfolio",
    "zero-nav",
    "null-nav",
  ]) {
    const x = structuredClone(c);
    if (kind === "missing-native")
      x.portfolio.positions = x.portfolio.positions.filter(
        (p) => p.address !== native,
      );
    if (kind === "missing-token")
      x.portfolio.positions = x.portfolio.positions.filter(
        (p) => p.address !== token.address,
      );
    if (kind === "unknown-value")
      x.portfolio.positions.find((p) => p.address === native)!.valueMicros =
        null;
    if (kind === "unknown-portfolio") x.portfolio.status = "UNKNOWN";
    if (kind === "zero-nav") x.portfolio.valueMicros = "0";
    if (kind === "null-nav") x.portfolio.valueMicros = null;
    const r = allocationReferenceBrief(x);
    assert.equal(r.combinedBnb.status, "UNKNOWN", kind);
    assert.equal(r.combinedBnb.valueMicros, null, kind);
    assert.equal(r.combinedBnb.weightBps, null, kind);
  }
});
test("configured address identity survives ordering and case but rejects symbol collisions and duplicate mappings", async () => {
  const c = await fixture(),
    expected = allocationReferenceBrief(c);
  const changed = structuredClone(c);
  changed.universe.reverse();
  changed.portfolio.positions.reverse();
  for (const a of changed.universe)
    a.address = a.address.toUpperCase().replace("0X", "0x");
  for (const p of changed.portfolio.positions) p.symbol = "BNB";
  assert.deepEqual(allocationReferenceBrief(changed), expected);
  for (const kind of [
    "symbol-only-native",
    "duplicate-native",
    "duplicate-token",
    "duplicate-market",
    "duplicate-address",
  ]) {
    const x = structuredClone(c),
      token = x.universe.find((a) => a.marketSymbol === "BNBUSDT")!;
    if (kind === "symbol-only-native")
      x.portfolio.positions.find((p) => p.address === native)!.address =
        "0x" + "11".repeat(20);
    if (kind === "duplicate-native")
      x.portfolio.positions.push({
        ...x.portfolio.positions.find((p) => p.address === native)!,
      });
    if (kind === "duplicate-token")
      x.portfolio.positions.push({
        ...x.portfolio.positions.find((p) => p.address === token.address)!,
      });
    if (kind === "duplicate-market")
      x.universe.push({ ...token, address: "0x" + "22".repeat(20) });
    if (kind === "duplicate-address") x.universe[0]!.address = token.address;
    const r = allocationReferenceBrief(x);
    assert.equal(r.combinedBnb.status, "UNKNOWN", kind);
    assert.equal(r.combinedBnb.weightBps, null, kind);
  }
});
test("prompt-only references preserve historical facts/checks and frozen context", async () => {
  const c = await fixture(),
    checks = researchChecks(c),
    facts = researchFacts(c),
    contextHash = hash(c),
    checksHash = hash(checks);
  for (const role of ["positions", "risk", undefined]) {
    const prompt = promptSnapshot(c, role);
    assert.deepEqual(
      prompt.allocationReferenceBrief,
      allocationReferenceBrief(c),
    );
  }
  assert.equal(hash(c), contextHash);
  assert.equal(hash(researchChecks(c)), checksHash);
  assert.deepEqual(researchFacts(c), facts);
  verifyResearchChecks(checks, c);
  assert.ok(!Object.hasOwn(c, "allocationReferenceBrief"));
  c.policy.maxAssetBps = 1200;
  c.policy.maxTotalBps = 4000;
  assert.deepEqual(allocationReferenceBrief(c).stableCommonModelCeilingsBps, {
    perAsset: 1200,
    total: 4000,
  });
});
