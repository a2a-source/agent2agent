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
