import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { hash } from "../src/protocol.js";
import { proveRoundNoExternalFlow } from "../src/round-cashflow.js";
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const blockHash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export function idleFixture(db: Store, block: number, nav = "100") {
  const registry = {
    chainId: 97,
    confirmations: 2,
    maxBlockAgeMs: 60000,
    maxPriceAgeMs: 60000,
    assets: ["BNB", "BTC", "ETH", "STABLE"].map((bucket, i) => ({
      asset: i ? address(i) : "native",
      bucket,
      decimals: i === 0 ? 18 : 6,
      feed: address(i + 10),
      description: bucket + " / USD",
    })),
  };
  const body = {
    version: "tracked-portfolio/1",
    requestId: "capture" + block + nav,
    agent: "a",
    wallet: address(20),
    chainId: 97,
    observedAt: block * 1000,
    validUntil: block * 1000 + 60000,
    blockNumber: block,
    blockHash: blockHash(block),
    registryHash: hash(registry),
    reservationSource: "round-observation",
    navMicros: nav,
    stableValueMicros: nav,
    availableStableMicros: nav,
    exposures: { BTC: "0", ETH: "0", BNB: "0" },
    availableExposures: { BTC: "0", ETH: "0", BNB: "0" },
    holdings: registry.assets.map((a) => ({
      asset: a.asset,
      bucket: a.bucket,
      balance: "100",
      reserved: "0",
      gasExcluded: "0",
      valueMicros: "25",
      availableMicros: "25",
      priceMicros: "1000000",
    })),
  };
  const s = { ...body, id: hash(body) };
  db.put("portfolio-snapshot", s.id, s);
  db.put("portfolio-capture", s.requestId, {
    status: "DONE",
    snapshotId: s.id,
    registry,
  });
  return s;
}
export const idleProvider = () => ({
  send: async (_m: string, args: any[]) => ({
    number: args[0],
    hash: blockHash(Number(BigInt(args[0]))),
  }),
  getNetwork: async () => ({ chainId: 97n }),
  getBlockNumber: async () => 10000,
  getCode: async () => "0x",
  getTransactionCount: async () => 0,
  getLogs: async () => [],
});
test("idle price move proves zero external flow at actual outer boundaries", async () => {
  const db = new Store(":memory:");
  try {
    const a = idleFixture(db, 10),
      b = idleFixture(db, 40, "110"),
      r = await proveRoundNoExternalFlow(
        db,
        idleProvider() as any,
        a.id,
        b.id,
        2,
      );
    assert.equal(r.status, "KNOWN");
    assert.equal(r.cashflow?.netExternalFlowMicros, "0");
    assert.equal(
      db.get<any>("round-cashflow-proof", r.proofId).openingSnapshotId,
      a.id,
    );
  } finally {
    db.close();
  }
});
test("missing nonce, external native flow and overlarge intervals stay UNKNOWN", async () => {
  for (const kind of ["nonce", "native", "large"]) {
    const db = new Store(":memory:");
    try {
      const a = idleFixture(db, 10),
        b = idleFixture(db, kind === "large" ? 5000 : 40),
        p = idleProvider();
      if (kind === "nonce") p.getTransactionCount = async () => 1;
      if (kind === "native") {
        b.holdings[0]!.balance = "101";
        const { id, ...body } = b;
        b.id = hash(body);
        db.put("portfolio-snapshot", b.id, b);
        db.put("portfolio-capture", b.requestId, {
          ...db.get<any>("portfolio-capture", b.requestId),
          snapshotId: b.id,
        });
      }
      if (kind === "nonce")
        p.getTransactionCount = async (...args: any[]) =>
          args[1] === 10 ? 0 : 1;
      const r = await proveRoundNoExternalFlow(db, p as any, a.id, b.id, 2);
      assert.equal(r.status, "UNKNOWN");
      assert.ok(r.reasons.length);
    } finally {
      db.close();
    }
  }
});
