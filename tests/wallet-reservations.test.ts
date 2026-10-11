import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { WalletReservations } from "../src/wallet-reservations.js";
const wallet = "0x" + "11".repeat(20),
  token = "0x" + "22".repeat(20);
function fixture() {
  const db = new Store(":memory:");
  db.put("portfolio-snapshot", "snapshot", {
    id: "snapshot",
    requestId: "capture",
    chainId: 97,
    wallet,
    agent: "a",
    observedAt: 100,
    validUntil: 1000,
    blockNumber: 10,
    blockHash: "0x" + "aa".repeat(32),
    holdings: [
      { asset: "native", balance: "100", reserved: "0", gasExcluded: "10" },
      { asset: token, balance: "1000", reserved: "0", gasExcluded: "0" },
    ],
  });
  db.put("portfolio-capture", "capture", {
    status: "DONE",
    snapshotId: "snapshot",
  });
  db.put("stable-wallet-plan", "plan", {
    id: "plan",
    snapshotId: "snapshot",
    wallet,
    agent: "a",
    chainId: 97,
    status: "READY",
    validUntil: 1000,
  });
  db.put("stable-qsp-consumption", "consumption", {
    id: "consumption",
    status: "PLANNED",
    planId: "plan",
    snapshotId: "snapshot",
    source: { qspHash: "q", confirmationHash: "c" },
  });
  return {
    db,
    ledger: new WalletReservations(db),
    request: {
      id: "r",
      planId: "plan",
      transactionIds: ["tx"],
      amounts: { [token]: "100", native: "5" },
    },
  };
}
test("reservation is atomic, idempotent and excludes competing wallet spend", () => {
  const x = fixture();
  try {
    const r = x.ledger.reserve(x.request, 200);
    assert.equal(r.status, "RESERVED");
    assert.deepEqual(x.ledger.reserve(x.request, 2000), r);
    assert.throws(
      () => x.ledger.reserve({ ...x.request, amounts: { native: "6" } }, 200),
      /conflict/,
    );
    assert.throws(
      () =>
        x.ledger.reserve(
          { ...x.request, id: "other", transactionIds: ["other-tx"] },
          200,
        ),
      /busy/,
    );
    assert.equal(x.db.all("wallet-reservation").length, 1);
  } finally {
    x.db.close();
  }
});
test("unsigned cancellation releases funds but Journal-before-ack prevents cancellation", () => {
  const x = fixture();
  try {
    x.ledger.reserve(x.request, 200);
    x.db.put("transaction", "tx", { id: "tx", sender: wallet, state: "READY" });
    assert.throws(() => x.ledger.cancel("r", 210), /journal/);
    assert.throws(() => x.ledger.settle("r", "snapshot", 220), /final/);
  } finally {
    x.db.close();
  }
  const y = fixture();
  try {
    y.ledger.reserve(y.request, 200);
    assert.equal(y.ledger.cancel("r", 210).status, "CANCELLED");
  } finally {
    y.db.close();
  }
});
test("reservation fails closed on stale sources or excess actual units", () => {
  for (const amounts of [
    { native: "101" },
    { [token]: "1001" },
    { [token]: "0" },
  ]) {
    const x = fixture();
    try {
      assert.throws(() => x.ledger.reserve({ ...x.request, amounts }, 200));
      assert.equal(x.db.all("wallet-reservation").length, 0);
    } finally {
      x.db.close();
    }
  }
  const x = fixture();
  try {
    assert.throws(() => x.ledger.reserve(x.request, 1000), /expired/);
  } finally {
    x.db.close();
  }
});
test("final receipts require later confirmed balances and prevent stale snapshot reuse", () => {
  const x = fixture();
  try {
    x.ledger.reserve(x.request, 200);
    x.db.put("transaction", "tx", {
      id: "tx",
      sender: wallet,
      state: "CONFIRMED",
      block: 11,
      blockHash: "0x" + "bb".repeat(32),
    });
    assert.throws(() => x.ledger.settle("r", "snapshot", 300), /snapshot/);
    const old = x.db.get<any>("portfolio-snapshot", "snapshot");
    x.db.put("portfolio-snapshot", "after", {
      ...old,
      id: "after",
      requestId: "after-capture",
      observedAt: 300,
      blockNumber: 12,
      blockHash: "0x" + "cc".repeat(32),
    });
    x.db.put("portfolio-capture", "after-capture", {
      status: "DONE",
      snapshotId: "after",
    });
    assert.equal(x.ledger.settle("r", "after", 310).status, "SETTLED");
    assert.throws(
      () =>
        x.ledger.reserve(
          { ...x.request, id: "next", transactionIds: ["next-tx"] },
          320,
        ),
      /snapshot/,
    );
  } finally {
    x.db.close();
  }
});
test("cancellation cannot race a signer that has not persisted signed bytes", () => {
  const x = fixture();
  try {
    x.ledger.reserve(x.request, 200);
    x.db.put("sender-lock", wallet, { owner: "signer", expires: 400 });
    assert.throws(() => x.ledger.cancel("r", 210), /signer/);
  } finally {
    x.db.close();
  }
});
test("snapshot preceding a known finalized wallet transaction cannot fund a reservation", () => {
  const x = fixture();
  try {
    x.db.put("transaction", "prior", {
      id: "prior",
      sender: wallet,
      state: "CONFIRMED",
      block: 11,
    });
    assert.throws(() => x.ledger.reserve(x.request, 200), /snapshot/);
  } finally {
    x.db.close();
  }
});
test("retryable reverted Journal entries cannot release reservations", () => {
  const x = fixture();
  try {
    x.ledger.reserve(x.request, 200);
    x.db.put("transaction", "tx", {
      id: "tx",
      sender: wallet,
      state: "REVERTED",
      block: 10,
      blockHash: "0x" + "aa".repeat(32),
    });
    assert.throws(() => x.ledger.settle("r", "snapshot", 210), /final/);
  } finally {
    x.db.close();
  }
});
test("aborted bound reverted or partial sequence releases only after fresh reconciliation", () => {
  const x = fixture();
  try {
    x.ledger.reserve(
      { ...x.request, transactionIds: ["tx", "unsigned-swap"] },
      200,
    );
    x.db.put("transaction", "tx", {
      id: "tx",
      sender: wallet,
      state: "REVERTED",
      block: 11,
      blockHash: "0x" + "bb".repeat(32),
      reservationId: "r",
    });
    assert.throws(() => x.ledger.abort("r", "snapshot", 300), /snapshot/);
    const old = x.db.get<any>("portfolio-snapshot", "snapshot");
    x.db.put("portfolio-snapshot", "after", {
      ...old,
      id: "after",
      requestId: "after-capture",
      observedAt: 300,
      blockNumber: 12,
    });
    x.db.put("portfolio-capture", "after-capture", {
      status: "DONE",
      snapshotId: "after",
    });
    assert.equal(x.ledger.abort("r", "after", 310).status, "ABORTED");
    assert.equal(
      x.db.get<any>("wallet-reservation", "r").reconciliationSnapshotId,
      "after",
    );
  } finally {
    x.db.close();
  }
});

test("native swap-only reservation binds value plus fee and settles without phantom approval", () => {
  const x = fixture();
  try {
    const request = { to: token, data: "0x1234", value: 80n };
    assert.throws(
      () => x.ledger.reserve({ ...x.request, amounts: { native: "91" } }, 200),
      /exceeds/,
    );
    const r = x.ledger.reserve(
      {
        ...x.request,
        amounts: { native: "90" },
        transactionIds: ["native-swap"],
      },
      200,
    );
    assert.throws(
      () => x.ledger.bind(r.id, "native-swap", request, "11", 900, 210),
      /budget/,
    );
    const binding = x.ledger.bind(r.id, "native-swap", request, "10", 900, 210);
    assert.equal(binding.nativeValueWei, "80");
    assert.throws(
      () =>
        x.ledger.bind(
          r.id,
          "native-swap",
          { ...request, value: 79n },
          "10",
          900,
          210,
        ),
      /conflict/,
    );
    x.db.put("transaction", "native-swap", {
      id: "native-swap",
      sender: wallet,
      state: "CONFIRMED",
      reservationId: r.id,
      block: 11,
      blockHash: "0x" + "bb".repeat(32),
    });
    const old = x.db.get<any>("portfolio-snapshot", "snapshot");
    x.db.put("portfolio-snapshot", "after", {
      ...old,
      id: "after",
      requestId: "after-capture",
      observedAt: 300,
      blockNumber: 12,
    });
    x.db.put("portfolio-capture", "after-capture", {
      status: "DONE",
      snapshotId: "after",
    });
    assert.equal(x.ledger.settle(r.id, "after", 310).status, "SETTLED");
  } finally {
    x.db.close();
  }
});
