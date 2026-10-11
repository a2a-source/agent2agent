import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet, Transaction } from "ethers";
import { Store } from "../src/store.js";
import { Journal } from "../src/chain.js";

test("external consumed nonce is isolated and never rebroadcast", async () => {
  const db = new Store(":memory:"),
    wallet = Wallet.createRandom();
  let nonce = 0,
    broadcasts = 0;
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => nonce,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => null,
    broadcastTransaction: async () => {
      broadcasts++;
    },
  };
  const journal = new Journal(db, provider, 97, true, { retryBaseMs: 0 });
  await journal.send("x", wallet.address, () => wallet, { to: wallet.address });
  nonce = 1;
  await journal.recover(1);
  await journal.recover(1);
  assert.equal(broadcasts, 1);
  assert.equal(
    db.get<any>("transaction", "x").recovery.reason,
    "NONCE_CONSUMED",
  );
  db.close();
});
test("bounded replacements retain payload and check every historical receipt", async () => {
  const db = new Store(":memory:"),
    w = Wallet.createRandom();
  const raws: string[] = [];
  let mined: string | undefined;
  const p: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => 0,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async (h: string) =>
      h === mined
        ? { hash: h, status: 1, blockNumber: 1, confirmations: async () => 2 }
        : null,
    broadcastTransaction: async (raw: string) => {
      raws.push(raw);
    },
  };
  const j = new Journal(db, p, 97, true, {
    retryBaseMs: 0,
    bumpAfterAttempts: 1,
    maxFeeBumps: 1,
    maxGasPriceWei: "10",
  });
  await j.send("x", w.address, () => w, { to: w.address, value: 7n });
  await j.send("x", w.address, () => w, { to: w.address, value: 7n });
  assert.equal(raws.length, 2);
  const a = Transaction.from(raws[0]),
    b = Transaction.from(raws[1]);
  assert.equal(a.nonce, b.nonce);
  assert.equal(a.value, b.value);
  assert.ok(b.gasPrice! > a.gasPrice!);
  mined = a.hash!;
  assert.equal(await j.confirmed("x", 1), true);
  assert.equal(db.get<any>("transaction", "x").hash, mined);
  db.close();
});

test("broadcast cap still probes receipts and RPC diagnostics contain no endpoint", async () => {
  const db = new Store(":memory:"),
    w = Wallet.createRandom();
  let broadcasts = 0,
    receipt: any = null;
  const p: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => 0,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => receipt,
    broadcastTransaction: async () => {
      broadcasts++;
      throw Error("https://secret.example/key");
    },
  };
  const j = new Journal(db, p, 97, true, { retryBaseMs: 0, maxAttempts: 1 });
  await assert.rejects(j.send("x", w.address, () => w, { to: w.address }));
  await j.recover(1);
  await j.recover(1);
  assert.equal(broadcasts, 1);
  assert.ok(!JSON.stringify(db.all("transaction-error")).includes("secret"));
  receipt = { status: 1, blockNumber: 3, confirmations: async () => 1 };
  await j.recover(1);
  assert.equal(db.get<any>("transaction", "x").state, "CONFIRMED");
  db.close();
});

test("logical retry requires a consumed reverted nonce and retains operation identity", async () => {
  const db = new Store(":memory:"),
    w = Wallet.createRandom();
  let nonce = 0;
  const raws: string[] = [];
  let reverted: string | undefined;
  const p: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => nonce,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async (h: string) =>
      h === reverted
        ? { hash: h, status: 0, blockNumber: 1, confirmations: async () => 1 }
        : null,
    broadcastTransaction: async (raw: string) => raws.push(raw),
  };
  const j = new Journal(db, p, 97, true, {
    retryBaseMs: 0,
    maxLogicalAttempts: 1,
  });
  const intent = { to: w.address, data: "0x1234" };
  await j.send("x", w.address, () => w, intent);
  reverted = Transaction.from(raws[0]).hash!;
  await assert.rejects(j.confirmed("x", 1));
  nonce = 1;
  await j.send("x", w.address, () => w, intent, {
    safeRetry: async () => true,
  });
  assert.equal(Transaction.from(raws[1]).nonce, 1);
  assert.equal(Transaction.from(raws[1]).data, "0x1234");
  assert.equal(db.all("transaction").length, 1);
  reverted = Transaction.from(raws[1]).hash!;
  await assert.rejects(j.confirmed("x", 1));
  nonce = 2;
  await assert.rejects(
    j.send("x", w.address, () => w, intent, { safeRetry: async () => true }),
  );
  assert.equal(raws.length, 2);
  db.close();
});

test("canonical receipt loss isolates an already confirmed intent", async () => {
  const db = new Store(":memory:"),
    w = Wallet.createRandom();
  let canonical = "0x" + "11".repeat(32),
    broadcasts = 0;
  const p: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => 0,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => ({
      status: 1,
      blockNumber: 1,
      blockHash: "0x" + "11".repeat(32),
      confirmations: async () => 1,
    }),
    getBlock: async () => ({ hash: canonical }),
    broadcastTransaction: async () => {
      broadcasts++;
    },
  };
  const j = new Journal(db, p, 97, true, { retryBaseMs: 0 });
  await j.send("x", w.address, () => w, { to: w.address });
  await j.confirmed("x", 1);
  canonical = "0x" + "22".repeat(32);
  await j.recover(1);
  assert.equal(
    db.get<any>("transaction", "x").recovery.reason,
    "CANONICAL_RECEIPT_MISSING",
  );
  assert.equal(db.get<any>("transaction", "x").state, "READY");
  assert.equal(broadcasts, 0);
  db.close();
});

function boundary() {
  const db = new Store(":memory:"),
    w = Wallet.createRandom();
  let nonce = 0,
    receipt: any = null,
    broadcasts = 0;
  const p: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => nonce,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => receipt,
    broadcastTransaction: async () => {
      broadcasts++;
    },
  };
  return {
    db,
    w,
    p,
    setNonce: (n: number) => {
      nonce = n;
    },
    setReceipt: (r: any) => {
      receipt = r;
    },
    broadcasts: () => broadcasts,
  };
}
test("terminal receipt polls preserve the logical retry due time", async () => {
  const f = boundary(),
    j = new Journal(f.db, f.p, 97, true, { retryBaseMs: 1000 });
  await j.send("x", f.w.address, () => f.w, { to: f.w.address });
  f.setReceipt({ status: 0, blockNumber: 1, confirmations: async () => 1 });
  await j.recover(1);
  const due = f.db.get<any>("transaction", "x").recovery.nextAt;
  await j.recover(1);
  await j.recover(1);
  assert.equal(f.db.get<any>("transaction", "x").recovery.nextAt, due);
  f.db.close();
});
test("exhausted transport automatically half-opens with exact bytes after cooldown", async () => {
  const f = boundary(),
    raws: string[] = [];
  let fails = true;
  f.p.broadcastTransaction = async (raw: string) => {
    raws.push(raw);
    if (fails) throw Error("offline");
  };
  const j = new Journal(f.db, f.p, 97, true, {
    retryBaseMs: 0,
    maxAttempts: 1,
    cooldownMs: 1000,
  });
  await assert.rejects(
    j.send("x", f.w.address, () => f.w, { to: f.w.address }),
  );
  await j.recover(1);
  assert.equal(raws.length, 1);
  const row = f.db.get<any>("transaction", "x");
  row.recovery.nextAt = 0;
  f.db.put("transaction", "x", row);
  fails = false;
  await j.recover(1);
  assert.equal(raws.length, 2);
  assert.equal(raws[0], raws[1]);
  f.db.close();
});
test("recovery cannot race an active sender lease or overwrite replacement history", async () => {
  const f = boundary();
  const j = new Journal(f.db, f.p, 97, true, { retryBaseMs: 0 });
  await j.send("x", f.w.address, () => f.w, { to: f.w.address });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.p.getTransactionReceipt = async () => {
    await gate;
    return null;
  };
  const sending = j.send("x", f.w.address, () => f.w, { to: f.w.address });
  await new Promise<void>((r) => setImmediate(r));
  await new Journal(f.db, f.p, 97, true).recover(1);
  release();
  await sending;
  assert.equal(f.broadcasts(), 2);
  f.db.close();
});
test("logical retry requires configured confirmation depth and matching network", async () => {
  const f = boundary(),
    j = new Journal(f.db, f.p, 97, true, { retryBaseMs: 0, confirmations: 3 });
  await j.send("x", f.w.address, () => f.w, { to: f.w.address });
  f.setReceipt({ status: 0, blockNumber: 1, confirmations: async () => 1 });
  await assert.rejects(j.confirmed("x", 1));
  f.setNonce(1);
  await assert.rejects(
    j.send(
      "x",
      f.w.address,
      () => f.w,
      { to: f.w.address },
      { safeRetry: async () => true },
    ),
  );
  assert.equal(f.broadcasts(), 1);
  f.p.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(
    j.send(
      "x",
      f.w.address,
      () => f.w,
      { to: f.w.address },
      { safeRetry: async () => true },
    ),
    /wrong chain/,
  );
  f.db.close();
});

test("lost sender lease fences retry writes and broadcast after awaited RPC", async () => {
  const f = boundary(),
    j = new Journal(f.db, f.p, 97, true, { retryBaseMs: 0 });
  await j.send("x", f.w.address, () => f.w, { to: f.w.address });
  const before = f.db.get<any>("transaction", "x");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.p.getTransactionCount = async () => {
    await gate;
    return 0;
  };
  const pending = j.send("x", f.w.address, () => f.w, { to: f.w.address });
  await new Promise<void>((r) => setImmediate(r));
  f.db.put("sender-lock", f.w.address.toLowerCase(), {
    owner: "new-owner",
    expires: Date.now() + 120000,
  });
  release();
  await assert.rejects(pending, /lease expired/);
  assert.equal(f.broadcasts(), 1);
  assert.deepEqual(f.db.get("transaction", "x"), before);
  f.db.close();
});

test("reverted logical intent cannot reuse another durable READY intent nonce", async () => {
  const f = boundary(),
    j = new Journal(f.db, f.p, 97, true, { retryBaseMs: 0 });
  const intent = { to: f.w.address };
  await j.send("a", f.w.address, () => f.w, intent);
  const a = f.db.get<any>("transaction", "a");
  f.p.getTransactionReceipt = async (h: string) =>
    h === a.hash
      ? { hash: h, status: 0, blockNumber: 1, confirmations: async () => 1 }
      : null;
  await assert.rejects(j.confirmed("a", 1));
  f.setNonce(1);
  await j.send("b", f.w.address.toLowerCase(), () => f.w, {
    to: f.w.address,
    value: 1n,
  });
  await assert.rejects(
    j.send("a", f.w.address, () => f.w, intent, {
      safeRetry: async () => true,
    }),
  );
  assert.equal(f.broadcasts(), 2);
  assert.equal(f.db.get<any>("transaction", "a").state, "REVERTED");
  assert.equal(f.db.get<any>("transaction", "a").recovery.logicalAttempts, 0);
  f.db.close();
});
test("reverted logical retry rejects externally pending next nonce", async () => {
  const f = boundary(),
    j = new Journal(f.db, f.p, 97, true, { retryBaseMs: 0 });
  const intent = { to: f.w.address };
  await j.send("a", f.w.address, () => f.w, intent);
  f.setReceipt({ status: 0, blockNumber: 1, confirmations: async () => 1 });
  await assert.rejects(j.confirmed("a", 1));
  f.p.getTransactionCount = async (_: string, tag: string) =>
    tag === "pending" ? 2 : 1;
  await assert.rejects(
    j.send("a", f.w.address, () => f.w, intent, {
      safeRetry: async () => true,
    }),
  );
  assert.equal(f.broadcasts(), 1);
  f.db.close();
});
test("canonical rollback releases isolation only for exact free nonce replay", async () => {
  const f = boundary(),
    raws: string[] = [];
  f.p.broadcastTransaction = async (raw: string) => raws.push(raw);
  const j = new Journal(f.db, f.p, 97, true, { retryBaseMs: 0, cooldownMs: 0 });
  await j.send("x", f.w.address, () => f.w, { to: f.w.address });
  f.setNonce(1);
  await j.recover(1);
  assert.equal(raws.length, 1);
  f.p.getTransactionCount = async (_: string, tag: string) =>
    tag === "pending" ? 1 : 0;
  await j.recover(1);
  assert.equal(raws.length, 1);
  f.setNonce(0);
  f.p.getTransactionCount = async () => 0;
  await j.recover(1);
  assert.equal(raws.length, 2);
  assert.equal(raws[0], raws[1]);
  assert.equal(Transaction.from(raws[1]).nonce, 0);
  f.db.close();
});

test("persisted transaction fee ceiling survives a restart with a higher replacement policy", async () => {
  const db = new Store(":memory:"),
    w = Wallet.createRandom(),
    raws: string[] = [];
  const p: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => 0,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => null,
    broadcastTransaction: async (raw: string) => {
      raws.push(raw);
    },
  };
  const policy = {
    retryBaseMs: 0,
    bumpAfterAttempts: 1,
    maxFeeBumps: 2,
    maxGasPriceWei: "10",
  };
  await new Journal(db, p, 97, true, {
    ...policy,
    maxTransactionFeeWei: "25200",
  }).send("capped", w.address, () => w, { to: w.address });
  await new Journal(db, p, 97, true, {
    ...policy,
    maxTransactionFeeWei: "999999",
  }).send("capped", w.address, () => w, { to: w.address });
  assert.equal(raws.length, 2);
  assert.equal(raws[0], raws[1]);
  assert.equal(db.get<any>("transaction", "capped").maxFeeWei, "25200");
  db.close();
});
