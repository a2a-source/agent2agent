import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaunch, findSalt } from "../src/flap.js";
import { Wallet, Interface, ZeroAddress } from "ethers";
import { Journal } from "../src/chain.js";
import { Store } from "../src/store.js";
test("Flap launch enforces 300bps taxes and a native BNB beneficiary", async () => {
  const portal = Wallet.createRandom().address,
    impl = Wallet.createRandom().address,
    beneficiary = Wallet.createRandom().address;
  const salt = await findSalt(portal, impl, "0x" + "11".repeat(32));
  assert.ok(salt.address.toLowerCase().endsWith("7777"));
  const p = buildLaunch(
    { name: "A", symbol: "A", meta: "bafy" },
    beneficiary,
    salt.salt,
    86400,
  );
  assert.equal(p.buyTaxRate, 300);
  assert.equal(p.sellTaxRate, 300);
  assert.equal(p.quoteToken, ZeroAddress);
  assert.equal(p.quoteAmt, 0n);
  assert.equal(p.beneficiary, beneficiary);
});
test("signed transaction survives ambiguous broadcast and is retried without a new nonce", async () => {
  const db = new Store(":memory:"),
    wallet = Wallet.createRandom();
  let raws: string[] = [];
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => 3,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    broadcastTransaction: async (raw: string) => {
      raws.push(raw);
      if (raws.length === 1) throw Error("network lost");
      return { hash: "ignored" };
    },
    getTransactionReceipt: async () => null,
  };
  const journal = new Journal(db, provider, 97, true);
  const intent = { to: Wallet.createRandom().address, value: 1n };
  await assert.rejects(
    journal.send("id", wallet.address, () => wallet, intent),
    /network/,
  );
  await journal.send("id", wallet.address, () => wallet, intent);
  assert.equal(raws[0], raws[1]);
  assert.equal(db.all("transaction").length, 1);
  await assert.rejects(
    journal.send("id", wallet.address, () => wallet, { ...intent, value: 2n }),
    /conflict/,
  );
  db.close();
});
test("two journal instances cannot sign different intents with the same sender nonce", async () => {
  const db = new Store(":memory:"),
    wallet = Wallet.createRandom();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const raws: string[] = [];
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => {
      await gate;
      return 0;
    },
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => null,
    broadcastTransaction: async (raw: string) => {
      raws.push(raw);
      return {};
    },
  };
  const first = new Journal(db, provider, 97, true).send(
    "one",
    wallet.address,
    () => wallet,
    { to: wallet.address, value: 1n },
  );
  await new Promise<void>((r) => setImmediate(r));
  const second = new Journal(db, provider, 97, true).send(
    "two",
    wallet.address,
    () => wallet,
    { to: wallet.address, value: 2n },
  );
  release();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(raws.length, 1);
  db.close();
});
test("recovery isolates one failed transaction and still checks other senders", async () => {
  const db = new Store(":memory:");
  for (const id of ["a", "b"])
    db.put("transaction", id, {
      id,
      sender: id,
      intentHash: id,
      raw: "0x01",
      hash: id,
      state: "READY",
    });
  const provider: any = {
    getTransactionReceipt: async (h: string) =>
      h === "a"
        ? { status: 0, blockNumber: 1, confirmations: async () => 1 }
        : { status: 1, blockNumber: 1, confirmations: async () => 1 },
    broadcastTransaction: async () => {
      throw Error("should not broadcast");
    },
  };
  await new Journal(db, provider, 97, true).recover(1);
  assert.equal(db.get<any>("transaction", "b").state, "CONFIRMED");
  assert.equal(db.get<any>("transaction", "a").state, "REVERTED");
  db.close();
});
test("confirmation ahead of the balance snapshot retains the outgoing reservation", async () => {
  const db = new Store(":memory:"),
    wallet = Wallet.createRandom();
  const raw = await wallet.signTransaction({
    to: wallet.address,
    value: 300000000000000000n,
    gasLimit: 21000n,
    gasPrice: 1n,
    nonce: 0,
    chainId: 97,
  });
  db.put("transaction", "stake", {
    id: "stake",
    sender: wallet.address,
    raw,
    state: "CONFIRMED",
    block: 100,
  });
  const journal = new Journal(db, {} as any, 97, true);
  assert.equal(journal.reserved(wallet.address, 99), 300000000000021000n);
  assert.equal(journal.reserved(wallet.address, 100), 0n);
  db.close();
});
