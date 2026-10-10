import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { transferDeltas } from "../src/dex-v2-fill.js";
const a = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const iface = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const log = (token: string, from: string, to: string, n: bigint) => ({
  address: token,
  ...iface.encodeEventLog(iface.getEvent("Transfer")!, [from, to, n]),
});
test("fill quantities come from wallet net transfer logs, not requested output", () => {
  const logs = [
    log(a(1), a(3), a(4), 100n),
    log(a(2), a(4), a(3), 99n),
    log(a(5), a(3), a(4), 500n),
    log(a(2), a(6), a(7), 600n),
  ];
  assert.deepEqual(transferDeltas(logs, a(3), [a(1), a(2)]), {
    input: 100n,
    output: 99n,
  });
});
test("self-transfers cancel and incoming refunds reduce the actual debit", () => {
  assert.deepEqual(
    transferDeltas(
      [
        log(a(1), a(3), a(3), 100n),
        log(a(1), a(3), a(4), 100n),
        log(a(1), a(4), a(3), 5n),
      ],
      a(3),
      [a(1), a(2)],
    ),
    { input: 95n, output: 0n },
  );
});

import { Wallet, Transaction } from "ethers";
import { Store } from "../src/store.js";
import { hash } from "../src/protocol.js";
import { recordV2Fill } from "../src/dex-v2-fill.js";
test("fill persists only canonical confirmed signed quote execution and is idempotent", async () => {
  const db = new Store(":memory:"),
    w = Wallet.createRandom(),
    wallet = w.address.toLowerCase();
  const blockHash = "0x" + "ab".repeat(32);
  const body = {
    configHash: "config",
    chainId: 97,
    router: a(7),
    factory: a(8),
    pair: a(4),
    wallet,
    path: [a(1), a(2)],
    amountIn: "100",
    amountOut: "99",
    minimumOut: "98",
    impactBps: 0,
    block: 9,
    blockHash,
    createdAt: 1000,
    validUntil: 10000,
  };
  const q = { ...body, id: hash(body) };
  const call = new Interface([
    "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  ]);
  const raw = await w.signTransaction({
    chainId: 97,
    nonce: 0,
    to: q.router,
    value: 0,
    data: call.encodeFunctionData("swapExactTokensForTokens", [
      100,
      98,
      q.path,
      wallet,
      10,
    ]),
    gasLimit: 100000,
    gasPrice: 1,
    type: 0,
  });
  const tx = Transaction.from(raw);
  db.put("dex-v2-quote", q.id, q);
  db.put("transaction", "swap", {
    id: "swap",
    raw,
    hash: tx.hash,
    sender: wallet,
    state: "CONFIRMED",
    block: 10,
    blockHash,
  });
  let canonical = true;
  const receipt = {
    hash: tx.hash!,
    from: wallet,
    to: q.router,
    status: 1,
    blockNumber: 10,
    blockHash,
    gasUsed: 50000n,
    gasPrice: 2n,
    confirmations: async () => 2,
    logs: [log(a(1), wallet, a(4), 100n), log(a(2), a(4), wallet, 99n)],
  };
  const provider = {
    getNetwork: async () => ({ chainId: 97n }),
    getTransactionReceipt: async () => receipt,
    send: async () => ({ hash: canonical ? blockHash : "different" }),
  };
  try {
    canonical = false;
    await assert.rejects(
      recordV2Fill(db, provider as any, q.id, "swap"),
      /canonical/,
    );
    assert.equal(db.all("dex-v2-fill").length, 0);
    canonical = true;
    receipt.hash = "wrong";
    await assert.rejects(
      recordV2Fill(db, provider as any, q.id, "swap"),
      /receipt/,
    );
    receipt.hash = tx.hash!;
    const fill = await recordV2Fill(db, provider as any, q.id, "swap");
    assert.equal(fill.gasWei, "100000");
    assert.equal(fill.amountOut, "99");
    assert.deepEqual(
      await recordV2Fill(db, provider as any, q.id, "swap"),
      fill,
    );
    assert.equal(db.all("dex-v2-fill").length, 1);
    const replacementRaw = await w.signTransaction({
      ...tx.toJSON(),
      gasPrice: 3n,
    });
    const current = db.get<any>("transaction", "swap");
    db.put("transaction", "swap", {
      ...current,
      raw: replacementRaw,
      hashes: [tx.hash, Transaction.from(replacementRaw).hash],
    });
    assert.deepEqual(
      await recordV2Fill(db, provider as any, q.id, "swap"),
      fill,
    );
    canonical = false;
    await assert.rejects(
      recordV2Fill(db, provider as any, q.id, "swap"),
      /canonical/,
    );
  } finally {
    db.close();
  }
});
