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

import { keccak256 } from "ethers";
import { V2Dex, v2QuoteRequest } from "../src/dex-v2.js";
import { reservedRequestHash } from "../src/reservation-signing.js";
async function nativeFixture(reverted = false) {
  const x = await fixture();
  const dex = new V2Dex(x.db, x.provider, {
    chainId: 97,
    router: address(50),
    factory: address(51),
    routerCodeHash: keccak256("0x6000"),
    factoryCodeHash: keccak256("0x6000"),
    tokens: [address(12), address(13)],
    wrappedNative: { address: address(12), codeHash: keccak256("0x6000") },
  });
  const body: any = {
    version: "dex-v2-quote/2",
    inputKind: "NATIVE",
    inputAsset: "native",
    wrappedNative: dex.config.wrappedNative,
    configHash: dex.configHash,
    chainId: 97,
    router: address(50),
    factory: address(51),
    pair: address(52),
    wallet: x.owner,
    path: [address(12), address(13)],
    amountIn: "100",
    amountOut: "100",
    minimumOut: "99",
    impactBps: 0,
    block: 10,
    blockHash: blockHash(10),
    createdAt: 10000,
    validUntil: 19000,
  };
  const q = { ...body, id: hash(body) };
  x.db.put("dex-v2-quote", q.id, q);
  const request = v2QuoteRequest(q);
  const raw = await x.wallet.signTransaction({
    ...request,
    chainId: 97,
    nonce: 5,
    gasLimit: 21000,
    gasPrice: 1,
    type: 0,
  });
  const tx = Transaction.from(raw);
  const row = {
    id: "native",
    sender: x.owner,
    reservationId: "reservation",
    raw,
    hash: tx.hash,
    state: reverted ? "REVERTED" : "CONFIRMED",
    block: 11,
    blockHash: blockHash(11),
  };
  x.db.put("transaction", row.id, row);
  const receipt: any = {
    hash: tx.hash,
    from: x.owner,
    to: address(50),
    status: reverted ? 0 : 1,
    blockNumber: 11,
    blockHash: blockHash(11),
    gasUsed: 21000n,
    gasPrice: 1n,
    logs: [],
    confirmations: async () => 10,
  };
  receipt.logs = reverted
    ? []
    : [
        x.makeLog(address(12), address(50), address(52), 100n, 0, receipt),
        x.makeLog(address(13), address(52), x.owner, 100n, 1, receipt),
      ];
  x.receipts.set(tx.hash!, receipt);
  x.setLogs(receipt.logs.filter((l: any) => l.address === address(13)));
  const abi = new Interface([
    "function WETH() view returns(address)",
    "function factory() view returns(address)",
  ]);
  x.provider.getCode = async (a: string) => (a === x.owner ? "0x" : "0x6000");
  x.provider.call = async (r: any) => {
    const c = abi.parseTransaction(r)!;
    return abi.encodeFunctionResult(c.name, [
      c.name === "WETH" ? address(12) : address(51),
    ]);
  };
  x.provider.getTransactionCount = async (_w: string, block: number) =>
    block === 10 ? 5 : 6;
  const { id: ignored, ...closingBody } = x.closing;
  closingBody.holdings = closingBody.holdings.map((h) => ({
    ...h,
    balance:
      h.asset === "native"
        ? String(1000000 - 21000 - (reverted ? 0 : 100))
        : h.bucket === "STABLE"
          ? String(1000 + (reverted ? 0 : 100))
          : "0",
  }));
  const closing = { ...closingBody, id: hash(closingBody) };
  x.db.put("portfolio-snapshot", closing.id, closing);
  x.db.put("portfolio-capture", closing.requestId, {
    status: "DONE",
    snapshotId: closing.id,
    registry: x.db.get<any>("portfolio-capture", x.opening.requestId).registry,
  });
  const registry = x.db.get<any>(
    "portfolio-capture",
    x.opening.requestId,
  ).registry;
  const deployment = {
      registry,
      dex: dex.config,
      options: {},
      gasReserveWei: "0",
    },
    configHash = hash(deployment);
  x.db.put("investment-execution-config", configHash, deployment);
  x.db.put("wallet-reservation", "reservation", {
    id: "reservation",
    planId: "plan",
    snapshotId: x.opening.id,
    chainId: 97,
    wallet: x.owner,
    transactionIds: [row.id],
    amounts: { native: "21100" },
  });
  x.db.put("wallet-reservation-binding", row.id, {
    id: row.id,
    reservationId: "reservation",
    chainId: 97,
    wallet: x.owner,
    requestHash: reservedRequestHash(request),
    nativeValueWei: "100",
    maxFeeWei: "21000",
  });
  x.db.put("investment-execution-reservation", "reservation", {
    planId: "plan",
    jobId: "job",
  });
  x.db.put("investment-execution-job", "job", {
    id: "job",
    planId: "plan",
    configHash,
    reservationId: "reservation",
    orders: [
      {
        version: "investment-execution-order/2",
        inputKind: "NATIVE",
        input: "native",
        output: address(13),
        amountIn: "100",
        swapId: row.id,
        quoteId: q.id,
        sourceOrderIndex: 0,
        intendedNotionalMicros: "100",
        notionalMicros: "100",
        residualMicros: "0",
      },
    ],
  });
  x.db.put("stable-wallet-plan", "plan", {
    id: "plan",
    snapshotId: x.opening.id,
    orders: [{ side: "SELL", bucket: "BNB", notionalMicros: "100" }],
  });
  return {
    ...x,
    q,
    row,
    closing,
    runNative: () =>
      proveExecutionNoExternalFlow(
        x.db,
        x.provider,
        x.opening.id,
        closing.id,
        [row.id],
        2,
      ),
  };
}
test("verified native conversion reconciles value separately from gas, with /2 proof evidence", async () => {
  const x = await nativeFixture();
  try {
    assert.equal((await x.runNative())?.complete, true);
    const proof = x.db
      .all<any>("execution-cashflow-proof")
      .find((p) => p.status === "KNOWN")!;
    assert.equal(proof.version, "execution-cashflow-proof/2");
    assert.equal(proof.nativeSwapValueWei, "100");
    assert.equal(proof.gasWei, "21000");
    assert.equal(proof.nativeSwaps[0].quoteId, x.q.id);
    const old = x.db.get<any>("wallet-reservation-binding", "native");
    x.db.put("wallet-reservation-binding", "native", {
      ...old,
      requestHash: "different",
    });
    assert.equal(await x.runNative(), undefined);
    x.db.put("wallet-reservation-binding", "native", old);
    x.db.sql.prepare("DELETE FROM records WHERE kind='dex-v2-config'").run();
    assert.equal(await x.runNative(), undefined);
  } finally {
    x.db.close();
  }
});
test("bound native revert spends gas only and unrelated positive value remains UNKNOWN", async () => {
  const x = await nativeFixture(true);
  try {
    assert.equal((await x.runNative())?.complete, true);
    const proof = x.db
      .all<any>("execution-cashflow-proof")
      .find((p) => p.status === "KNOWN")!;
    assert.equal(proof.nativeSwapValueWei, "0");
    assert.equal(x.db.all("dex-v2-fill").length, 0);
    x.db.put("investment-execution-job", "job", {
      ...x.db.get<any>("investment-execution-job", "job"),
      orders: [],
    });
    assert.equal(await x.runNative(), undefined);
  } finally {
    x.db.close();
  }
});

test("native foreign inflow and registered-token discrepancy remain UNKNOWN after verified swap", async () => {
  for (const asset of ["native", address(13)]) {
    const x = await nativeFixture();
    try {
      const { id: ignored, ...body } = x.closing;
      body.holdings = body.holdings.map((h) =>
        h.asset === asset
          ? { ...h, balance: String(BigInt(h.balance) + 1n) }
          : h,
      );
      const closing = { ...body, id: hash(body) };
      x.db.put("portfolio-snapshot", closing.id, closing);
      const capture = x.db.get<any>("portfolio-capture", closing.requestId);
      x.db.put("portfolio-capture", closing.requestId, {
        ...capture,
        snapshotId: closing.id,
      });
      assert.equal(
        await proveExecutionNoExternalFlow(
          x.db,
          x.provider,
          x.opening.id,
          closing.id,
          [x.row.id],
          2,
        ),
        undefined,
      );
      assert.equal(
        x.db.all<any>("execution-cashflow-proof")[0]!.status,
        "UNKNOWN",
      );
    } finally {
      x.db.close();
    }
  }
});

test("native intent RPC outages remain retryable and resume after transport recovery", async () => {
  for (const method of ["getCode", "call"]) {
    const x = await nativeFixture(true);
    try {
      const read = x.provider[method];
      x.provider[method] = async (...args: any[]) => {
        if (method === "call" || args[0] !== x.owner)
          throw Error("transport unavailable");
        return read(...args);
      };
      await assert.rejects(x.runNative(), /RPC unavailable/);
      assert.deepEqual(
        x.db.all<any>("execution-cashflow-proof").at(-1)!.reasons,
        ["RPC_UNAVAILABLE"],
      );
      x.provider[method] = read;
      assert.equal((await x.runNative())?.complete, true);
    } finally {
      x.db.close();
    }
  }
});
test("native fill RPC revalidation outages remain retryable and recover without UNKNOWN finalization", async () => {
  for (const method of [
    "getNetwork",
    "getTransactionReceipt",
    "send",
    "confirmations",
  ]) {
    const x = await nativeFixture();
    try {
      const receipt = x.receipts.get(x.row.hash!)!;
      const target = method === "confirmations" ? receipt : x.provider;
      const read = target[method];
      let calls = 0;
      target[method] = async (...args: any[]) => {
        calls++;
        const inFill =
          method === "confirmations" ||
          (method === "send" ? Number(BigInt(args[1][0])) === 11 : calls === 2);
        if (inFill) throw Error("fill RPC transport unavailable");
        return read(...args);
      };
      await assert.rejects(x.runNative(), /RPC unavailable/);
      assert.deepEqual(
        x.db.all<any>("execution-cashflow-proof").at(-1)!.reasons,
        ["RPC_UNAVAILABLE"],
      );
      target[method] = read;
      assert.equal((await x.runNative())?.complete, true);
    } finally {
      x.db.close();
    }
  }
});
test("native deployment and fill validation failures remain permanent UNKNOWN rather than RPC retries", async () => {
  for (const mismatch of ["wrappedHash", "WETH", "funding"]) {
    const x = await nativeFixture();
    try {
      if (mismatch === "wrappedHash") {
        const read = x.provider.getCode;
        x.provider.getCode = async (a: string) =>
          a === address(12) ? "0x6001" : read(a);
      } else if (mismatch === "WETH") {
        const abi = new Interface([
          "function WETH() view returns(address)",
          "function factory() view returns(address)",
        ]);
        x.provider.call = async (r: any) => {
          const c = abi.parseTransaction(r)!;
          return abi.encodeFunctionResult(c.name, [
            c.name === "WETH" ? address(999) : address(51),
          ]);
        };
      } else {
        x.receipts.get(x.row.hash!)!.logs.splice(0, 1);
      }
      assert.equal(await x.runNative(), undefined);
      const proof = x.db.all<any>("execution-cashflow-proof").at(-1)!;
      assert.equal(proof.status, "UNKNOWN");
      assert.notDeepEqual(proof.reasons, ["RPC_UNAVAILABLE"]);
    } finally {
      x.db.close();
    }
  }
});

test("structured unsupported proof exposes the exact persisted reason and identity", async () => {
  const { proveExecutionNoExternalFlowResult } =
    await import("../src/execution-cashflow.js");
  const db = new Store(":memory:");
  try {
    const result = await proveExecutionNoExternalFlowResult(
      db,
      {} as any,
      "missing",
      "missing2",
      [],
      2,
    );
    assert.equal(result.status, "UNKNOWN");
    assert.deepEqual(result.reasons, ["SNAPSHOT_MISSING"]);
    assert.equal(
      db.get<any>("execution-cashflow-proof", result.proofId).status,
      "UNKNOWN",
    );
  } finally {
    db.close();
  }
});

async function roundNativeFixture() {
  const x = await nativeFixture();
  for (const id of x.txIds) x.db.remove("transaction", id);
  const clone = (source: any, block: number) => {
    const { id, ...body } = source;
    Object.assign(body, {
      requestId: "outer" + block,
      blockNumber: block,
      blockHash: blockHash(block),
      observedAt: block * 1000,
      reservationSource: "round-observation",
    });
    const row = { ...body, id: hash(body) };
    x.db.put("portfolio-snapshot", row.id, row);
    x.db.put("portfolio-capture", row.requestId, {
      ...x.db.get<any>("portfolio-capture", source.requestId),
      snapshotId: row.id,
    });
    return row;
  };
  const a = clone(x.opening, 5),
    b = clone(x.closing, 25);
  x.provider.getBlockNumber = async () => 30;
  x.provider.getTransactionCount = async (_w: string, block: number) =>
    block <= 10 ? 5 : 6;
  const getLogs = x.provider.getLogs;
  x.provider.getLogs = async (filter: any) =>
    (await getLogs(filter)).filter(
      (l: any) =>
        l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock,
    );
  const job = {
    ...x.db.get<any>("investment-execution-job", "job"),
    chainId: 97,
    wallet: x.owner,
    agent: "agent",
    status: "DONE",
    closingSnapshotId: x.closing.id,
  };
  x.db.put("investment-execution-job", "job", job);
  const { proveRoundNoExternalFlow } = await import("../src/round-cashflow.js");
  return {
    ...x,
    a,
    b,
    job,
    clone,
    runRound: () => proveRoundNoExternalFlow(x.db, x.provider, a.id, b.id, 2),
  };
}
test("native round cover preserves job snapshots and proves both empty gaps", async () => {
  const x = await roundNativeFixture();
  try {
    const r = await x.runRound();
    assert.equal(r.status, "KNOWN");
    const proof = x.db.get<any>("round-cashflow-proof", r.proofId);
    assert.equal(proof.segments.length, 3);
    assert.equal(proof.segments[1].openingSnapshotId, x.opening.id);
    assert.equal(proof.segments[1].closingSnapshotId, x.closing.id);
    assert.deepEqual(proof.transactionIds, ["native"]);
    assert.ok(proof.blockChecks.length >= 4);
    const binding = x.db.get<any>("wallet-reservation-binding", "native");
    x.db.put("wallet-reservation-binding", "native", {
      ...binding,
      nativeValueWei: "101",
    });
    assert.equal((await x.runRound()).status, "UNKNOWN");
  } finally {
    x.db.close();
  }
});
test("native covers reject nonfinal, straddling, duplicate, foreign gap and reorg evidence", async () => {
  for (const kind of [
    "nonfinal",
    "straddle",
    "duplicate",
    "gap",
    "reorg",
    "limit",
    "registry",
  ]) {
    const x = await roundNativeFixture();
    try {
      if (kind === "nonfinal")
        x.db.put("investment-execution-job", "job", {
          ...x.job,
          status: "ACTIVE",
        });
      if (kind === "duplicate")
        x.db.put("investment-execution-job", "second", {
          ...x.job,
          id: "second",
        });
      if (kind === "straddle") {
        const a = x.clone(x.opening, 1);
        x.db.put("stable-wallet-plan", "plan", {
          ...x.db.get<any>("stable-wallet-plan", "plan"),
          snapshotId: a.id,
        });
      }
      if (kind === "gap")
        x.provider.getTransactionCount = async (_w: string, b: number) =>
          b === 5 ? 4 : b <= 10 ? 5 : 6;
      if (kind === "reorg") {
        const original = x.provider.send;
        let count = 0;
        x.provider.send = async (m: string, args: any[]) => {
          const b = await original(m, args);
          return Number(BigInt(args[0])) === 10 && ++count > 2
            ? { ...b, hash: blockHash(999) }
            : b;
        };
      }
      if (kind === "limit")
        for (let i = 0; i < 17; i++)
          x.db.put("investment-execution-job", "extra" + i, {
            ...x.job,
            id: "extra" + i,
          });
      if (kind === "registry") {
        const a = x.clone(x.opening, 10);
        const { id, ...body } = a;
        body.registryHash = "1".repeat(64);
        const r = { ...body, id: hash(body) };
        x.db.put("portfolio-snapshot", r.id, r);
        x.db.put("stable-wallet-plan", "plan", {
          ...x.db.get<any>("stable-wallet-plan", "plan"),
          snapshotId: r.id,
        });
      }
      const r = await x.runRound();
      assert.equal(r.status, "UNKNOWN", kind);
      assert.ok(r.reasons.length, kind);
    } finally {
      x.db.close();
    }
  }
});

test("native cover permits equal same-block joins but rejects contradictory raw holdings", async () => {
  for (const mismatch of [false, true]) {
    const x = await roundNativeFixture();
    try {
      const a = x.clone(x.opening, 10),
        b = x.clone(x.closing, 20);
      Object.assign(x.a, a);
      Object.assign(x.b, b);
      if (mismatch) {
        const { id, ...body } = a;
        body.holdings = body.holdings.map((h: any) =>
          h.asset === "native"
            ? { ...h, balance: String(BigInt(h.balance) + 1n) }
            : h,
        );
        const changed = { ...body, id: hash(body) };
        x.db.put("portfolio-snapshot", changed.id, changed);
        x.db.put("portfolio-capture", changed.requestId, {
          ...x.db.get<any>("portfolio-capture", changed.requestId),
          snapshotId: changed.id,
        });
        Object.assign(x.a, changed);
      }
      const result = await x.runRound();
      assert.equal(result.status, mismatch ? "UNKNOWN" : "KNOWN");
      if (mismatch)
        assert.deepEqual(result.reasons, ["ZERO_LENGTH_JOIN_MISMATCH"]);
      else
        assert.equal(
          x.db
            .get<any>("round-cashflow-proof", result.proofId)
            .segments.filter((s: any) => s.zeroLength).length,
          2,
        );
    } finally {
      x.db.close();
    }
  }
});

async function twoNativeJobsFixture() {
  const x = await roundNativeFixture();
  const secondOpening = x.clone(x.closing, 25);
  const { id: _quoteId, ...quoteBody } = x.q;
  const secondQuoteBody = {
    ...quoteBody,
    block: 25,
    blockHash: blockHash(25),
    createdAt: 25000,
    validUntil: 34000,
  };
  const secondQuote = { ...secondQuoteBody, id: hash(secondQuoteBody) };
  x.db.put("dex-v2-quote", secondQuote.id, secondQuote);
  const request = v2QuoteRequest(secondQuote);
  const raw = await x.wallet.signTransaction({
    ...request,
    chainId: 97,
    nonce: 6,
    gasLimit: 21000,
    gasPrice: 1,
    type: 0,
  });
  const tx = Transaction.from(raw);
  const row = {
    ...x.row,
    id: "native-second",
    reservationId: "reservation-second",
    raw,
    hash: tx.hash!,
    block: 26,
    blockHash: blockHash(26),
  };
  x.db.put("transaction", row.id, row);
  const receipt: any = {
    hash: tx.hash!,
    from: x.owner,
    to: address(50),
    status: 1,
    blockNumber: 26,
    blockHash: blockHash(26),
    gasUsed: 21000n,
    gasPrice: 1n,
    logs: [],
    confirmations: async () => 20,
  };
  receipt.logs = [
    x.makeLog(address(12), address(50), address(52), 100n, 0, receipt),
    x.makeLog(address(13), address(52), x.owner, 100n, 1, receipt),
  ];
  x.receipts.set(tx.hash!, receipt);
  x.setLogs([
    ...x.logs(),
    ...receipt.logs.filter((l: any) => l.address === address(13)),
  ]);
  const { id: _closingId, ...closingBody } = secondOpening;
  Object.assign(closingBody, {
    requestId: "second-close",
    blockNumber: 35,
    blockHash: blockHash(35),
    observedAt: 35000,
  });
  closingBody.holdings = closingBody.holdings.map((h: any) => ({
    ...h,
    balance:
      h.asset === "native"
        ? String(BigInt(h.balance) - 21100n)
        : h.bucket === "STABLE"
          ? String(BigInt(h.balance) + 100n)
          : h.balance,
  }));
  const secondClosing = { ...closingBody, id: hash(closingBody) };
  x.db.put("portfolio-snapshot", secondClosing.id, secondClosing);
  x.db.put("portfolio-capture", secondClosing.requestId, {
    ...x.db.get<any>("portfolio-capture", secondOpening.requestId),
    snapshotId: secondClosing.id,
  });
  const reservation = {
    ...x.db.get<any>("wallet-reservation", "reservation"),
    id: "reservation-second",
    planId: "plan-second",
    snapshotId: secondOpening.id,
    transactionIds: [row.id],
  };
  x.db.put("wallet-reservation", reservation.id, reservation);
  x.db.put("wallet-reservation-binding", row.id, {
    ...x.db.get<any>("wallet-reservation-binding", "native"),
    id: row.id,
    reservationId: reservation.id,
    requestHash: reservedRequestHash(request),
  });
  x.db.put("investment-execution-reservation", reservation.id, {
    planId: "plan-second",
    jobId: "job-second",
  });
  x.db.put("stable-wallet-plan", "plan-second", {
    ...x.db.get<any>("stable-wallet-plan", "plan"),
    id: "plan-second",
    snapshotId: secondOpening.id,
  });
  const secondJob = {
    ...x.job,
    id: "job-second",
    planId: "plan-second",
    reservationId: reservation.id,
    closingSnapshotId: secondClosing.id,
    orders: x.job.orders.map((o: any) => ({
      ...o,
      swapId: row.id,
      quoteId: secondQuote.id,
    })),
  };
  x.db.put("investment-execution-job", secondJob.id, secondJob);
  x.provider.getBlockNumber = async () => 42;
  x.provider.getTransactionCount = async (_w: string, block: number) =>
    block < 11 ? 5 : block < 26 ? 6 : 7;
  const { PortfolioCollector } = await import("../src/portfolio-snapshot.js");
  const registry = x.db.get<any>(
    "portfolio-capture",
    x.opening.requestId,
  ).registry;
  let at = 5000;
  const collector = new PortfolioCollector(
    x.db,
    {
      chainId: async () => 97,
      tip: async () => 42,
      block: async (n: number) => ({
        number: n,
        hash: blockHash(n),
        timestamp: n,
      }),
      read: async (asset: any, _wallet: string, block: number) => ({
        balance: (block === 5 ? x.opening : secondClosing).holdings.find(
          (h: any) => h.asset === asset.asset,
        )!.balance,
        decimals: asset.decimals,
        price: {
          answer: "1000000000000",
          decimals: 0,
          description: asset.description,
          roundId: "1",
          answeredInRound: "1",
          updatedAt: block,
        },
      }),
    },
    registry,
    () => at,
  );
  const capture = async (block: number) => {
    at = block * 1000;
    return collector.collectAt(
      {
        id: "valued-outer" + block,
        agent: "agent",
        wallet: x.owner,
        gasReserveWei: "0",
        reservationSource: "round-observation",
        reserved: Object.fromEntries(
          registry.assets.map((a: any) => [a.asset, "0"]),
        ),
      },
      {
        blockNumber: block,
        blockHash: blockHash(block),
        blockTimeMs: block * 1000,
      },
    );
  };
  Object.assign(x.a, await capture(5));
  Object.assign(x.b, await capture(40));
  return {
    ...x,
    secondOpening,
    secondClosing,
    secondQuote,
    secondJob,
    secondRow: row,
  };
}

test("two separately bound native jobs prove the empty middle gap and publish outer PnL with gas once", async () => {
  const x = await twoNativeJobsFixture();
  try {
    const result = await x.runRound();
    assert.equal(result.status, "KNOWN");
    const cover = x.db.get<any>("round-cashflow-proof", result.proofId);
    assert.deepEqual(cover.transactionIds, ["native", "native-second"]);
    assert.equal(cover.segments.length, 5);
    assert.deepEqual(
      cover.segments.map((s: any) => [
        s.openingSnapshotId,
        s.closingSnapshotId,
        s.transactionIds,
      ]),
      [
        [x.a.id, x.opening.id, []],
        [x.opening.id, x.closing.id, ["native"]],
        [x.closing.id, x.secondOpening.id, []],
        [x.secondOpening.id, x.secondClosing.id, ["native-second"]],
        [x.secondClosing.id, x.b.id, []],
      ],
    );
    const middle = x.db.get<any>(
      "execution-cashflow-proof",
      cover.segments[2].proofId,
    );
    assert.equal(middle.status, "KNOWN");
    assert.deepEqual(middle.nonceBounds, { opening: 6, closing: 6 });
    const { publishRoundObservation } =
      await import("../src/round-observation.js");
    const { validateRoundCashflowProof } =
      await import("../src/round-observation-evidence.js");
    const { PerformanceLedger } = await import("../src/performance-ledger.js");
    assert.equal(
      validateRoundCashflowProof(x.db, result.proofId, x.a.id, x.b.id),
      "KNOWN",
    );
    const published = publishRoundObservation(
      x.db,
      {
        chainId: 97,
        roundId: "two-native",
        sourceStatus: "PUBLISHED",
        terminalAt: 39000,
        observedAt: 40000,
        roster: [{ agentId: "agent", wallet: x.owner }],
        rosterComplete: true,
        predecessorId: null,
        registryHash: x.a.registryHash,
        configHash: hash({}),
        openingBoundary: {
          blockNumber: 5,
          blockHash: blockHash(5),
          blockTimeMs: 5000,
        },
        closingBoundary: {
          blockNumber: 40,
          blockHash: blockHash(40),
          blockTimeMs: 40000,
        },
        lifecycle: "COMPLETE",
        wallets: [
          {
            agentId: "agent",
            wallet: x.owner,
            openingSnapshotId: x.a.id,
            closingSnapshotId: x.b.id,
            proofIds: [result.proofId],
            captureAttemptIds: [],
            missingReasons: [],
          },
        ],
        missingReasons: [],
      },
      null,
    );
    assert.equal(x.a.navMicros, "1001000");
    assert.equal(x.b.navMicros, "959000");
    const ledger = new PerformanceLedger(x.db).latest(
      "two-native",
      97,
      "micro-USD",
    )!;
    assert.equal(ledger.network.periodPnL, "-42000");
    assert.deepEqual(ledger.network.periodReturn, {
      numerator: "-42000",
      denominator: "1001000",
    });
    assert.equal((ledger as any).observationId, published.id);
    const { id: _coverId, ...omitted } = cover;
    omitted.segments = omitted.segments.filter((_s: any, i: number) => i !== 2);
    const omittedId = hash(omitted);
    x.db.put("round-cashflow-proof", omittedId, { ...omitted, id: omittedId });
    assert.throws(
      () => validateRoundCashflowProof(x.db, omittedId, x.a.id, x.b.id),
      /OBSERVATION_PROOF_COVER_INVALID/,
    );
  } finally {
    x.db.close();
  }
});

test("distinct native transaction windows reject overlap specifically and detect a foreign middle-gap nonce", async () => {
  for (const kind of ["overlap", "foreign-nonce", "foreign-journal"]) {
    const x = await twoNativeJobsFixture();
    try {
      if (kind === "overlap") {
        const overlap = x.clone(x.secondOpening, 15);
        x.db.put("stable-wallet-plan", "plan-second", {
          ...x.db.get<any>("stable-wallet-plan", "plan-second"),
          snapshotId: overlap.id,
        });
        x.db.put("wallet-reservation", "reservation-second", {
          ...x.db.get<any>("wallet-reservation", "reservation-second"),
          snapshotId: overlap.id,
        });
      } else {
        // A separate outgoing nonce in (20,25] cannot disappear between native windows.
        x.provider.getTransactionCount = async (_w: string, block: number) =>
          block < 11 ? 5 : block < 23 ? 6 : block < 26 ? 7 : 8;
        if (kind === "foreign-journal") {
          const raw = await x.wallet.signTransaction({
            to: address(60),
            chainId: 97,
            nonce: 6,
            gasLimit: 21000,
            gasPrice: 1,
            type: 0,
            value: 0,
          });
          const tx = Transaction.from(raw);
          x.db.put("transaction", "foreign-gap", {
            id: "foreign-gap",
            sender: x.owner,
            raw,
            hash: tx.hash,
            state: "CONFIRMED",
            block: 23,
            blockHash: blockHash(23),
          });
        }
      }
      const result = await x.runRound();
      assert.equal(result.status, "UNKNOWN");
      assert.deepEqual(result.reasons, [
        kind === "overlap"
          ? "NATIVE_SEGMENTS_OVERLAP"
          : kind === "foreign-journal"
            ? "NATIVE_COVER_TRANSACTION_MISMATCH"
            : "NONCE_COVERAGE_INCOMPLETE",
      ]);
    } finally {
      x.db.close();
    }
  }
});
