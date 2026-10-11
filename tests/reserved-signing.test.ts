import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { Store } from "../src/store.js";
import { Journal } from "../src/chain.js";
import { WalletReservations } from "../src/wallet-reservations.js";
function setup() {
  const db = new Store(":memory:"),
    wallet = Wallet.createRandom(),
    sender = wallet.address.toLowerCase();
  let broadcasts = 0;
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionCount: async () => 0,
    getFeeData: async () => ({ gasPrice: 1n }),
    estimateGas: async () => 21000n,
    getTransactionReceipt: async () => null,
    broadcastTransaction: async () => {
      broadcasts++;
      return {};
    },
  };
  db.put("wallet-reservation", "r", {
    id: "r",
    planId: "plan",
    chainId: 97,
    wallet: sender,
    status: "RESERVED",
    transactionIds: ["trade"],
    amounts: { native: "50000" },
    createdAt: Date.now() - 1000,
  });
  db.put("stable-wallet-plan", "plan", { validUntil: Date.now() + 60000 });
  const ledger = new WalletReservations(db);
  return {
    db,
    wallet,
    sender,
    provider,
    ledger,
    journal: new Journal(db, provider, 97, true),
    broadcasts: () => broadcasts,
    request: { to: sender, value: 0n, data: "0x" },
  };
}
test("an active investment reservation prevents unrelated staking or transfer signing", async () => {
  const x = setup();
  try {
    await assert.rejects(
      x.journal.send("stake", x.sender, () => x.wallet, x.request),
      /reservation/,
    );
    assert.equal(x.broadcasts(), 0);
    assert.equal(x.db.all("transaction").length, 0);
  } finally {
    x.db.close();
  }
});
test("listed transaction needs immutable binding; exact reserved transaction signs once", async () => {
  const x = setup();
  try {
    await assert.rejects(
      x.journal.send("trade", x.sender, () => x.wallet, x.request),
      /binding/,
    );
    x.ledger.bind(
      "r",
      "trade",
      x.request,
      "30000",
      Date.now() + 30000,
      Date.now(),
    );
    await x.journal.send("trade", x.sender, () => x.wallet, x.request);
    assert.equal(x.broadcasts(), 1);
    assert.equal(x.db.get<any>("transaction", "trade").maxFeeWei, "30000");
  } finally {
    x.db.close();
  }
});
test("changed call, oversized gas and revoked reservation fail before signed bytes persist", async () => {
  for (const scenario of ["data", "gas", "cancel"]) {
    const x = setup();
    try {
      x.ledger.bind(
        "r",
        "trade",
        x.request,
        "30000",
        Date.now() + 30000,
        Date.now(),
      );
      if (scenario === "gas") x.provider.estimateGas = async () => 30000n;
      if (scenario === "cancel") x.ledger.cancel("r", Date.now());
      await assert.rejects(
        x.journal.send(
          "trade",
          x.sender,
          () => x.wallet,
          scenario === "data" ? { ...x.request, data: "0x1234" } : x.request,
        ),
        /reservation|binding/,
      );
      assert.equal(x.db.all("transaction").length, 0);
      assert.equal(x.broadcasts(), 0);
    } finally {
      x.db.close();
    }
  }
});
test("expiration during signing cannot persist or broadcast signed bytes", async () => {
  const x = setup();
  try {
    const deadline = Date.now() + 30000;
    x.ledger.bind("r", "trade", x.request, "30000", deadline, Date.now());
    const original = x.wallet.signTransaction.bind(x.wallet);
    x.wallet.signTransaction = async (r) => {
      const raw = await original(r);
      const b = x.db.get<any>("wallet-reservation-binding", "trade");
      x.db.put("wallet-reservation-binding", "trade", { ...b, validUntil: 0 });
      return raw;
    };
    await assert.rejects(
      x.journal.send("trade", x.sender, () => x.wallet, x.request),
      /binding/,
    );
    assert.equal(x.broadcasts(), 0);
    assert.equal(x.db.all("transaction").length, 0);
  } finally {
    x.db.close();
  }
});
test("a reserved reverted transaction cannot create a new logical attempt", async () => {
  const x = setup();
  try {
    x.ledger.bind(
      "r",
      "trade",
      x.request,
      "30000",
      Date.now() + 30000,
      Date.now(),
    );
    await x.journal.send("trade", x.sender, () => x.wallet, x.request);
    const row = x.db.get<any>("transaction", "trade");
    x.db.put("transaction", "trade", { ...row, state: "REVERTED" });
    await assert.rejects(
      x.journal.send("trade", x.sender, () => x.wallet, x.request, {
        safeRetry: async () => true,
      }),
      /terminal reconciliation/,
    );
    assert.equal(x.broadcasts(), 1);
  } finally {
    x.db.close();
  }
});
test("recovery does not broadcast signed reserved bytes after reservation is terminal", async () => {
  const x = setup();
  try {
    x.ledger.bind(
      "r",
      "trade",
      x.request,
      "30000",
      Date.now() + 30000,
      Date.now(),
    );
    await x.journal.send("trade", x.sender, () => x.wallet, x.request);
    x.db.put("wallet-reservation", "r", {
      ...x.db.get<any>("wallet-reservation", "r"),
      status: "SETTLED",
    });
    await x.journal.send("trade", x.sender, () => x.wallet, x.request);
    assert.equal(x.broadcasts(), 1);
    assert.equal(
      x.db.get<any>("transaction", "trade").recovery.reason,
      "RESERVATION_TERMINAL",
    );
  } finally {
    x.db.close();
  }
});
test("an older unreserved pending transaction cannot rebroadcast into a newly reserved wallet", async () => {
  const x = setup();
  try {
    const reservation = x.db.get<any>("wallet-reservation", "r");
    x.db.remove("wallet-reservation", "r");
    await x.journal.send("legacy", x.sender, () => x.wallet, x.request);
    x.db.put("wallet-reservation", "r", reservation);
    await x.journal.send("legacy", x.sender, () => x.wallet, x.request);
    assert.equal(x.broadcasts(), 1);
    assert.equal(
      x.db.get<any>("transaction", "legacy").recovery.reason,
      "WALLET_FUNDS_RESERVED",
    );
  } finally {
    x.db.close();
  }
});
test("an older reverted transfer cannot sign a logical retry across a new reservation", async () => {
  const x = setup();
  try {
    const reservation = x.db.get<any>("wallet-reservation", "r");
    x.db.remove("wallet-reservation", "r");
    await x.journal.send("legacy", x.sender, () => x.wallet, x.request);
    const old = x.db.get<any>("transaction", "legacy");
    x.db.put("transaction", "legacy", {
      ...old,
      state: "REVERTED",
      recovery: {
        attempts: 0,
        feeBumps: 0,
        logicalAttempts: 0,
        started: Date.now(),
        nextAt: 0,
        reason: "REVERTED",
        isolated: false,
      },
    });
    x.db.put("wallet-reservation", "r", reservation);
    x.provider.getTransactionReceipt = async () => ({
      hash: old.hash,
      status: 0,
      blockNumber: 1,
      confirmations: async () => 3,
    });
    x.provider.getTransactionCount = async () => 1;
    let signatures = 0;
    await assert.rejects(
      x.journal.send(
        "legacy",
        x.sender,
        () => {
          signatures++;
          return x.wallet;
        },
        x.request,
        { safeRetry: async () => true },
      ),
      /reservation/,
    );
    assert.equal(signatures, 0);
    assert.equal(x.db.get<any>("transaction", "legacy").state, "REVERTED");
  } finally {
    x.db.close();
  }
});
test("reserved transaction identity cannot be claimed by another wallet or chain", async () => {
  for (const mode of ["wallet", "chain"]) {
    const x = setup();
    try {
      x.ledger.bind(
        "r",
        "trade",
        x.request,
        "30000",
        Date.now() + 30000,
        Date.now(),
      );
      const other = mode === "wallet" ? Wallet.createRandom() : x.wallet;
      if (mode === "chain")
        x.provider.getNetwork = async () => ({ chainId: 56n });
      const journal = new Journal(
        x.db,
        x.provider,
        mode === "chain" ? 56 : 97,
        true,
      );
      await assert.rejects(
        journal.send("trade", other.address, () => other, x.request),
        /reservation/,
      );
      assert.equal(x.broadcasts(), 0);
      assert.equal(x.db.all("transaction").length, 0);
    } finally {
      x.db.close();
    }
  }
});
test("fee replacement cannot persist after binding expires during signing", async () => {
  const x = setup();
  try {
    x.db.put("wallet-reservation", "r", {
      ...x.db.get<any>("wallet-reservation", "r"),
      amounts: { native: "5000000" },
    });
    x.provider.getFeeData = async () => ({ gasPrice: 100n });
    const journal = new Journal(x.db, x.provider, 97, true, {
      maxFeeBumps: 1,
      bumpAfterAttempts: 1,
      maxGasPriceWei: "1000",
    });
    x.ledger.bind(
      "r",
      "trade",
      x.request,
      "3000000",
      Date.now() + 30000,
      Date.now(),
    );
    await journal.send("trade", x.sender, () => x.wallet, x.request);
    const before = x.db.get<any>("transaction", "trade");
    const sign = x.wallet.signTransaction.bind(x.wallet);
    x.wallet.signTransaction = async (r) => {
      const raw = await sign(r);
      x.db.put("wallet-reservation-binding", "trade", {
        ...x.db.get<any>("wallet-reservation-binding", "trade"),
        validUntil: 0,
      });
      return raw;
    };
    await assert.rejects(
      journal.send("trade", x.sender, () => x.wallet, x.request),
      /binding/,
    );
    assert.equal(x.db.get<any>("transaction", "trade").raw, before.raw);
    assert.equal(x.broadcasts(), 1);
  } finally {
    x.db.close();
  }
});
test("expired binding permits exact-byte recovery but never a new fee signature", async () => {
  const x = setup(),
    clock = Date.now;
  try {
    x.db.put("wallet-reservation", "r", {
      ...x.db.get<any>("wallet-reservation", "r"),
      amounts: { native: "5000000" },
    });
    x.provider.getFeeData = async () => ({ gasPrice: 100n });
    const journal = new Journal(x.db, x.provider, 97, true, {
      maxFeeBumps: 1,
      bumpAfterAttempts: 1,
      maxGasPriceWei: "1000",
    });
    const deadline = clock() + 30000;
    x.ledger.bind("r", "trade", x.request, "3000000", deadline, clock());
    let signatures = 0;
    const signer = () => {
      signatures++;
      return x.wallet;
    };
    await journal.send("trade", x.sender, signer, x.request);
    const raw = x.db.get<any>("transaction", "trade").raw;
    Date.now = () => deadline + 1;
    await journal.send("trade", x.sender, signer, x.request);
    assert.equal(signatures, 1);
    assert.equal(x.broadcasts(), 2);
    assert.equal(x.db.get<any>("transaction", "trade").raw, raw);
  } finally {
    Date.now = clock;
    x.db.close();
  }
});
