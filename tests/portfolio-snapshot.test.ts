import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { PortfolioCollector } from "../src/portfolio-snapshot.js";
export const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
export const registry = {
  chainId: 97,
  confirmations: 2,
  maxBlockAgeMs: 60000,
  maxPriceAgeMs: 60000,
  assets: [
    {
      asset: "native",
      bucket: "BNB",
      decimals: 18,
      feed: addr(10),
      description: "BNB / USD",
    },
    {
      asset: addr(1),
      bucket: "BNB",
      decimals: 18,
      feed: addr(10),
      description: "BNB / USD",
    },
    {
      asset: addr(2),
      bucket: "BTC",
      decimals: 18,
      feed: addr(11),
      description: "BTC / USD",
    },
    {
      asset: addr(3),
      bucket: "ETH",
      decimals: 18,
      feed: addr(12),
      description: "ETH / USD",
    },
    {
      asset: addr(4),
      bucket: "STABLE",
      decimals: 6,
      feed: addr(13),
      description: "USDT / USD",
    },
  ],
};
export const request = {
  id: "snapshot-1",
  agent: "agent",
  wallet: addr(20),
  gasReserveWei: "1000000000000000",
  reservationSource: "test-reservations-v1",
  reserved: {
    native: "0",
    [addr(1)]: "0",
    [addr(2)]: "0",
    [addr(3)]: "0",
    [addr(4)]: "0",
  },
};
export function reader() {
  return {
    chainId: async () => 97,
    tip: async () => 12,
    block: async (number: number) => ({
      number,
      hash: "0x" + "11".repeat(32),
      timestamp: 990,
    }),
    read: async (asset: any, wallet: string, block: number) => {
      assert.equal(block, 10);
      assert.equal(wallet, addr(20));
      return {
        balance:
          asset.asset === "native"
            ? "1000000000000000"
            : asset.bucket === "STABLE"
              ? "1000000000"
              : "0",
        decimals: asset.decimals,
        price: {
          answer: asset.bucket === "STABLE" ? "99000000" : "10000000000",
          decimals: 8,
          description: asset.description,
          roundId: "1",
          answeredInRound: "1",
          updatedAt: 980,
        },
      };
    },
  };
}
test("confirmed collector values stablecoin from oracle, journals raw observations and replays", async () => {
  const db = new Store(":memory:");
  try {
    const r = reader(),
      collector = new PortfolioCollector(db, r, registry, () => 1000000);
    const s = await collector.collect(request);
    assert.equal(s.navMicros, "990000000");
    assert.equal(s.availableStableMicros, "990000000");
    assert.equal(s.exposures.BNB, "0");
    assert.equal(s.blockNumber, 10);
    assert.equal(db.all("portfolio-observation").length, 5);
    r.read = async () => {
      throw Error("must not call");
    };
    assert.deepEqual(await collector.collect(request), s);
    await assert.rejects(
      collector.collect({ ...request, gasReserveWei: "0" }),
      /conflict/,
    );
  } finally {
    db.close();
  }
});
test("reorg, stale feed, decimal mismatch and over-reservation fail without usable snapshot", async () => {
  for (const kind of [
    "reorg",
    "stale",
    "decimals",
    "reserved",
    "chain",
    "confirmations",
    "description",
    "future",
    "zero",
    "round",
  ]) {
    const db = new Store(":memory:");
    try {
      const r = reader();
      if (kind === "chain") r.chainId = async () => 56;
      if (kind === "confirmations") r.tip = async () => 1;
      let blocks = 0;
      if (kind === "reorg")
        r.block = async (number) => ({
          number,
          hash: "0x" + (++blocks === 1 ? "11" : "22").repeat(32),
          timestamp: 990,
        });
      const original = r.read;
      r.read = async (...args) => {
        const x = await original(...args);
        if (kind === "stale") x.price.updatedAt = 1;
        if (kind === "decimals") x.decimals = 5;
        if (kind === "description") x.price.description = "OTHER / USD";
        if (kind === "future") x.price.updatedAt = 995;
        if (kind === "zero") x.price.answer = "0";
        if (kind === "round") x.price.answeredInRound = "0";
        return x;
      };
      const req = structuredClone(request);
      if (kind === "reserved") req.reserved.native = "999999999999999999999";
      await assert.rejects(
        new PortfolioCollector(db, r, registry, () => 1000000).collect(req),
      );
      assert.equal(db.all("portfolio-snapshot").length, 0);
      assert.equal(db.all<any>("portfolio-capture")[0].status, "FAILED");
    } finally {
      db.close();
    }
  }
});

test("native and wrapped BNB exposures combine while Gas and pending funds have distinct treatment", async () => {
  const db = new Store(":memory:");
  try {
    const r = reader(),
      original = r.read;
    r.read = async (...args) => {
      const x = await original(...args);
      if (args[0].bucket === "BNB")
        x.balance =
          args[0].asset === "native"
            ? "1001000000000000000"
            : "2000000000000000000";
      return x;
    };
    const req = structuredClone(request);
    req.reserved.native = "500000000000000000";
    req.reserved[addr(1)] = "1000000000000000000";
    const s = await new PortfolioCollector(
      db,
      r,
      registry,
      () => 1000000,
    ).collect(req);
    assert.equal(s.exposures.BNB, "300000000");
    assert.equal(s.availableExposures.BNB, "150000000");
    assert.equal(s.navMicros, "1290000000");
  } finally {
    db.close();
  }
});

test("failed RPC read retains the attempted asset and bounded failure without provider credentials", async () => {
  const db = new Store(":memory:");
  try {
    const r = reader();
    r.read = async () => {
      throw Error("secret-rpc-url");
    };
    await assert.rejects(
      new PortfolioCollector(db, r, registry, () => 1000000).collect(request),
    );
    const observations = db.all<any>("portfolio-observation");
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, "FAILED");
    assert.equal(observations[0].asset.asset, "native");
    assert.ok(!JSON.stringify(observations).includes("secret-rpc-url"));
  } finally {
    db.close();
  }
});

test("ethers reader bypasses provider getBlock cache for both canonical hash checks", async () => {
  const { EthersPortfolioReader } =
    await import("../src/portfolio-snapshot.js");
  let reads = 0;
  const provider: any = {
    getBlock: async () => {
      throw Error("cached getBlock forbidden");
    },
    send: async (method: string, args: any[]) => {
      assert.equal(method, "eth_getBlockByNumber");
      assert.deepEqual(args, ["0xa", false]);
      return {
        number: "0xa",
        timestamp: "0x3de",
        hash: "0x" + (++reads === 1 ? "11" : "22").repeat(32),
      };
    },
  };
  const r = new EthersPortfolioReader(provider);
  const first = await r.block(10),
    second = await r.block(10);
  assert.notEqual(first.hash, second.hash);
  assert.equal(reads, 2);
});

test("historical accounting reads keep actual read time, full native NAV and a pinned boundary", async () => {
  const db = new Store(":memory:");
  try {
    const c = new PortfolioCollector(db, reader(), registry, () => 2000000),
      boundary = {
        blockNumber: 10,
        blockHash: "0x" + "11".repeat(32),
        blockTimeMs: 990000,
      };
    const req = {
      ...request,
      gasReserveWei: "0",
      reservationSource: "round-observation",
    };
    const s = await c.collectAt(req, boundary);
    assert.equal(s.observedAt, 2000000);
    assert.equal(s.blockNumber, 10);
    assert.equal(s.navMicros, "990100000");
    assert.ok(s.validUntil < 2000000);
    assert.deepEqual(await c.collectAt(req, boundary), s);
    await assert.rejects(c.collect(req), /conflict/);
    await assert.rejects(
      c.collectAt(req, { ...boundary, blockNumber: 11 }),
      /conflict/,
    );
    await assert.rejects(c.collect({ ...req, id: "fresh" }));
  } finally {
    db.close();
  }
});
test("accounting pin rejects unconfirmed, reorg and wrong timestamp boundaries and retains partial observations", async () => {
  for (const kind of ["confirmation", "hash", "time", "partial"]) {
    const db = new Store(":memory:");
    try {
      const r = reader(),
        boundary = {
          blockNumber: 10,
          blockHash: "0x" + "11".repeat(32),
          blockTimeMs: 990000,
        };
      if (kind === "confirmation") r.tip = async () => 11;
      if (kind === "hash") boundary.blockHash = "0x" + "22".repeat(32);
      if (kind === "time") boundary.blockTimeMs = 989000;
      if (kind === "partial") {
        const original = r.read;
        r.read = async (...args) => {
          if (args[0].asset !== "native") throw Error("offline");
          return original(...args);
        };
      }
      await assert.rejects(
        new PortfolioCollector(db, r, registry, () => 2000000).collectAt(
          {
            ...request,
            gasReserveWei: "0",
            reservationSource: "round-observation",
          },
          boundary,
        ),
      );
      assert.equal(db.all("portfolio-snapshot").length, 0);
      if (kind === "partial")
        assert.equal(
          db
            .all<any>("portfolio-observation")
            .filter((x) => x.status === "RETURNED").length,
          1,
        );
    } finally {
      db.close();
    }
  }
});
