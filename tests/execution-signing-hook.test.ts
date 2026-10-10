import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Store } from "../src/store.js";
import { Journal } from "../src/chain.js";
import { bindReservedTransaction } from "../src/reservation-signing.js";
function fixture(marked = true) {
  const db = new Store(":memory:");
  const wallet = Wallet.createRandom();
  const request = { to: Wallet.createRandom().address, value: 0n };
  const now = Date.now();
  db.put("stable-wallet-plan", "plan", { validUntil: now + 60000 });
  db.put("wallet-reservation", "reservation", {
    id: "reservation",
    planId: "plan",
    status: "RESERVED",
    chainId: 97,
    wallet: wallet.address.toLowerCase(),
    transactionIds: ["tx"],
    createdAt: now,
    amounts: { native: "1000000" },
  });
  bindReservedTransaction(
    db,
    "reservation",
    "tx",
    request,
    "1000000",
    now + 60000,
    now,
  );
  if (marked)
    db.put("investment-execution-reservation", "reservation", {
      planId: "plan",
    });
  const raws: string[] = [];
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => 0,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => null,
    broadcastTransaction: async (raw: string) => {
      raws.push(raw);
      return {};
    },
  };
  return { db, wallet, request, provider, raws };
}
test("execution-owned reservations fail closed without a live source hook", async () => {
  const x = fixture();
  try {
    await assert.rejects(
      new Journal(x.db, x.provider, 97, true).send(
        "tx",
        x.wallet.address,
        () => x.wallet,
        x.request,
      ),
      /execution source hook required/,
    );
    assert.equal(x.db.all("transaction").length, 0);
    assert.equal(x.raws.length, 0);
  } finally {
    x.db.close();
  }
});
test("source authority is rechecked after an awaited signer before durable bytes", async () => {
  const x = fixture();
  try {
    let valid = true;
    const sign = x.wallet.signTransaction.bind(x.wallet);
    x.wallet.signTransaction = async (request) => {
      const raw = await sign(request);
      valid = false;
      return raw;
    };
    const journal = new Journal(x.db, x.provider, 97, true, {}, (planId) => {
      assert.equal(planId, "plan");
      if (!valid) throw Error("authority revoked");
    });
    await assert.rejects(
      journal.send("tx", x.wallet.address, () => x.wallet, x.request),
      /authority revoked/,
    );
    assert.equal(x.db.all("transaction").length, 0);
    assert.equal(x.raws.length, 0);
  } finally {
    x.db.close();
  }
});
test("unmarked reservation keeps legacy signing behavior", async () => {
  const x = fixture(false);
  try {
    await new Journal(x.db, x.provider, 97, true).send(
      "tx",
      x.wallet.address,
      () => x.wallet,
      x.request,
    );
    assert.equal(x.db.all("transaction").length, 1);
    assert.equal(x.raws.length, 1);
  } finally {
    x.db.close();
  }
});
