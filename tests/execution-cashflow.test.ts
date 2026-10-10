import test from "node:test";
import assert from "node:assert/strict";
import { Interface, Wallet, Transaction } from "ethers";
import { Store } from "../src/store.js";
import { hash } from "../src/protocol.js";
import { proveExecutionNoExternalFlow } from "../src/execution-cashflow.js";
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const blockHash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const iface = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
async function fixture() {
  const db = new Store(":memory:"),
    wallet = Wallet.createRandom(),
    owner = wallet.address.toLowerCase();
  const registry = {
    chainId: 97,
    confirmations: 2,
    maxBlockAgeMs: 600000,
    maxPriceAgeMs: 600000,
    assets: [
      {
        asset: "native",
        bucket: "BNB",
        decimals: 18,
        feed: address(31),
        description: "BNB / USD",
      },
      ...["BTC", "ETH", "BNB", "STABLE"].map((bucket, i) => ({
        asset: address(10 + i),
        bucket,
        decimals: 18,
        feed: address(32 + i),
        description: bucket + " / USD",
      })),
    ],
  };
  const snapshot = (block: number) => {
    const holdings = registry.assets.map((a) => ({
      asset: a.asset,
      bucket: a.bucket,
      balance:
        a.asset === "native"
          ? String(block === 10 ? 1000000 : 937000)
          : a.bucket === "STABLE"
            ? block === 10
              ? "1000"
              : "900"
            : a.bucket === "BTC"
              ? block === 10
                ? "0"
                : "100"
              : "0",
      reserved: "0",
      gasExcluded: "0",
      valueMicros: "0",
      availableMicros: "0",
      priceMicros: "1000000",
    }));
    const body = {
      version: "tracked-portfolio/1",
      requestId: "capture" + block,
      agent: "agent",
      wallet: owner,
      chainId: 97,
      observedAt: block * 1000,
      validUntil: 100000,
      blockNumber: block,
      blockHash: blockHash(block),
      registryHash: hash(registry),
      reservationSource: "fixture",
      navMicros: "0",
      stableValueMicros: "0",
      availableStableMicros: "0",
      exposures: { BTC: "0", ETH: "0", BNB: "0" },
      availableExposures: { BTC: "0", ETH: "0", BNB: "0" },
      holdings,
    };
    const row = { ...body, id: hash(body) };
    db.put("portfolio-snapshot", row.id, row);
    db.put("portfolio-capture", body.requestId, {
      status: "DONE",
      snapshotId: row.id,
      registry,
      request: { agent: "agent", wallet: owner },
    });
    return row;
  };
  const opening = snapshot(10),
    closing = snapshot(20),
    receipts = new Map<string, any>(),
    txIds = ["approve", "swap", "revert"];
  for (let i = 0; i < 3; i++) {
    const raw = await wallet.signTransaction({
        chainId: 97,
        nonce: 5 + i,
        to: address(50),
        value: 0n,
        data: "0x",
        gasLimit: 21000,
        gasPrice: 1,
        type: 0,
      }),
      tx = Transaction.from(raw);
    db.put("transaction", txIds[i]!, {
      id: txIds[i],
      sender: owner,
      intentHash: "fixture",
      raw,
      hash: tx.hash,
      state: i === 2 ? "REVERTED" : "CONFIRMED",
      block: 11 + i,
      blockHash: blockHash(11 + i),
    });
    receipts.set(tx.hash!, {
      hash: tx.hash,
      from: owner,
      to: address(50),
      status: i === 2 ? 0 : 1,
      blockNumber: 11 + i,
      blockHash: blockHash(11 + i),
      gasUsed: 21000n,
      gasPrice: 1n,
      logs: [],
      confirmations: async () => 10,
    });
  }
  const swapReceipt = receipts.get(db.get<any>("transaction", "swap").hash)!;
  const makeLog = (
    token: string,
    from: string,
    to: string,
    amount: bigint,
    index: number,
    receipt = swapReceipt,
  ) => ({
    address: token,
    ...iface.encodeEventLog(iface.getEvent("Transfer")!, [from, to, amount]),
    index,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    removed: false,
  });
  swapReceipt.logs = [
    makeLog(address(13), owner, address(50), 100n, 0),
    makeLog(address(10), address(50), owner, 100n, 1),
    makeLog(address(10), owner, owner, 1n, 2),
  ];
  let apiLogs = [...swapReceipt.logs];
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getBlockNumber: async () => 22,
    getCode: async () => "0x",
    getTransactionCount: async (_w: string, block: number) =>
      block === 10 ? 5 : 8,
    getTransactionReceipt: async (h: string) => receipts.get(h) ?? null,
    send: async (_m: string, args: any[]) => {
      const n = Number(BigInt(args[0]));
      return { number: args[0], hash: blockHash(n) };
    },
    getLogs: async (filter: any) =>
      apiLogs.filter(
        (l) =>
          l.address === filter.address &&
          filter.topics.every(
            (topic: string | null, i: number) =>
              topic === null || l.topics[i] === topic,
          ),
      ),
  };
  const run = () =>
    proveExecutionNoExternalFlow(
      db,
      provider,
      opening.id,
      closing.id,
      txIds,
      2,
    );
  return {
    db,
    wallet,
    provider,
    opening,
    closing,
    receipts,
    txIds,
    run,
    owner,
    makeLog,
    swapReceipt,
    setLogs: (logs: any[]) => (apiLogs = logs),
    logs: () => apiLogs,
  };
}
test("zero-flow proof covers approval, swap, revert gas and self-transfer duplicate logs", async () => {
  const x = await fixture();
  try {
    const proof = await x.run();
    assert.equal(proof?.complete, true);
    assert.equal(proof?.netExternalFlowMicros, "0");
    assert.equal(proof?.hasExternalFlows, false);
    const row = x.db.get<any>(
      "execution-cashflow-proof",
      proof!.provenance[0]!,
    );
    assert.equal(row.status, "KNOWN");
    assert.equal(row.gasWei, "63000");
    assert.deepEqual(row.nonceBounds, { opening: 5, closing: 8 });
    assert.equal(row.transactions.length, 3);
    assert.deepEqual(await x.run(), proof);
    assert.equal(x.db.all("execution-cashflow-proof").length, 1);
  } finally {
    x.db.close();
  }
});
test("external flows, missing evidence, rebasing and incomplete nonce coverage remain unknown", async () => {
  for (const kind of [
    "native-deposit",
    "nonce-gap",
    "omitted-transaction",
    "external-transfer",
    "missing-log",
    "rebase",
    "zero-gas",
    "missing-gas",
    "contract-wallet",
    "reorg",
    "unconfirmed",
    "wrong-chain",
    "nonzero-value",
    "duplicate-id",
    "too-wide",
  ]) {
    const x = await fixture();
    try {
      const rewriteSnapshot = (changes: any) => {
        const { id, ...body } = x.closing;
        const replacement = { ...body, ...changes };
        const row = { ...replacement, id: hash(replacement) };
        x.db.remove("portfolio-snapshot", id);
        x.db.put("portfolio-snapshot", row.id, row);
        x.db.put("portfolio-capture", row.requestId, {
          ...x.db.get<any>("portfolio-capture", row.requestId),
          snapshotId: row.id,
        });
        Object.assign(x.closing, row);
      };
      if (kind === "native-deposit" || kind === "rebase") {
        const row = x.db.get<any>("portfolio-snapshot", x.closing.id);
        row.holdings.find(
          (h: any) =>
            h.asset === (kind === "native-deposit" ? "native" : address(10)),
        ).balance = "9999999";
        rewriteSnapshot({ holdings: row.holdings });
      }
      if (kind === "nonce-gap")
        x.provider.getTransactionCount = async (_w: string, b: number) =>
          b === 10 ? 5 : 9;
      if (kind === "omitted-transaction") x.txIds.pop();
      if (kind === "external-transfer") {
        const external = { ...x.swapReceipt, hash: "0x" + "ab".repeat(32) };
        x.setLogs([
          ...x.logs(),
          x.makeLog(address(10), address(99), x.owner, 1n, 3, external),
        ]);
      }
      if (kind === "missing-log") x.setLogs(x.logs().slice(1));
      if (kind === "zero-gas") x.swapReceipt.gasUsed = 0n;
      if (kind === "missing-gas") delete x.swapReceipt.gasPrice;
      if (kind === "contract-wallet") x.provider.getCode = async () => "0x6000";
      if (kind === "reorg")
        x.provider.send = async (_m: string, args: any[]) => ({
          number: args[0],
          hash: blockHash(999),
        });
      if (kind === "unconfirmed") x.swapReceipt.confirmations = async () => 1;
      if (kind === "wrong-chain")
        x.provider.getNetwork = async () => ({ chainId: 56n });
      if (kind === "nonzero-value") {
        const row = x.db.get<any>("transaction", "swap");
        row.raw = await x.wallet.signTransaction({
          chainId: 97,
          nonce: 6,
          to: address(50),
          value: 1n,
          data: "0x",
          gasLimit: 21000,
          gasPrice: 1,
          type: 0,
        });
        row.hash = Transaction.from(row.raw).hash;
        x.db.put("transaction", "swap", row);
      }
      if (kind === "duplicate-id") x.txIds.push("swap");
      if (kind === "too-wide") rewriteSnapshot({ blockNumber: 5000 });
      assert.equal(await x.run(), undefined, kind);
      const proof = x.db.all<any>("execution-cashflow-proof").at(-1);
      assert.equal(proof.status, "UNKNOWN", kind);
      assert.ok(proof.reasons.length, kind);
      if (kind === "native-deposit")
        assert.deepEqual(proof.reasons, ["NATIVE_FLOW_UNEXPLAINED"]);
      if (kind === "rebase")
        assert.deepEqual(proof.reasons, ["TOKEN_BALANCE_UNEXPLAINED"]);
      if (kind === "external-transfer")
        assert.deepEqual(proof.reasons, ["EXTERNAL_TOKEN_TRANSFER"]);
      if (kind === "too-wide")
        assert.deepEqual(proof.reasons, ["INTERVAL_TOO_LARGE"]);
    } finally {
      x.db.close();
    }
  }
});
test("transient RPC failure persists a sanitized unknown proof and throws for retry", async () => {
  const x = await fixture();
  try {
    const original = x.provider.getLogs;
    x.provider.getLogs = async () => {
      throw Error("secret RPC URL https://secret.invalid/key");
    };
    await assert.rejects(x.run(), /cashflow proof RPC unavailable/);
    const rows = x.db.all<any>("execution-cashflow-proof");
    assert.equal(rows[0].status, "UNKNOWN");
    assert.deepEqual(rows[0].reasons, ["RPC_UNAVAILABLE"]);
    assert.doesNotMatch(JSON.stringify(rows), /secret/);
    x.provider.getLogs = original;
    assert.equal((await x.run())?.complete, true);
  } finally {
    x.db.close();
  }
});
test("older mined replacement bytes are recovered from durable Journal history", async () => {
  const x = await fixture();
  try {
    const row = x.db.get<any>("transaction", "approve");
    x.db.put("transaction", "approve", {
      ...row,
      raw: await x.wallet.signTransaction({
        chainId: 97,
        nonce: 5,
        to: address(50),
        value: 0n,
        data: "0x",
        gasLimit: 21000,
        gasPrice: 2,
        type: 0,
      }),
    });
    assert.equal((await x.run())?.complete, true);
  } finally {
    x.db.close();
  }
});

test("a boundary reorg during log collection fails the final canonical pin", async () => {
  const x = await fixture();
  try {
    const original = x.provider.send;
    let closingReads = 0;
    x.provider.send = async (method: string, args: any[]) => {
      const b = await original(method, args);
      if (Number(BigInt(args[0])) === 20 && ++closingReads === 3)
        return { ...b, hash: blockHash(999) };
      return b;
    };
    assert.equal(await x.run(), undefined);
    assert.deepEqual(x.db.all<any>("execution-cashflow-proof")[0].reasons, [
      "CANONICAL_BLOCK_MISMATCH",
    ]);
  } finally {
    x.db.close();
  }
});
test("missing zero-net receipt logs and conflicting self-transfer duplicates fail closed", async () => {
  for (const conflict of [false, true]) {
    const x = await fixture();
    try {
      if (conflict)
        x.setLogs([
          ...x.logs(),
          x.makeLog(address(10), x.owner, x.owner, 2n, 2),
        ]);
      else x.setLogs(x.logs().slice(0, 2));
      assert.equal(await x.run(), undefined);
      assert.deepEqual(x.db.all<any>("execution-cashflow-proof")[0].reasons, [
        conflict ? "CONFLICTING_TRANSFER_LOG" : "TRANSFER_LOG_MISSING",
      ]);
    } finally {
      x.db.close();
    }
  }
});
