import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Store } from "../src/store.js";
import { WalletVault } from "../src/wallet.js";
import { Agents } from "../src/agents.js";
import { Budget } from "../src/budget.js";
import { splitTax, stakeDeficit, nodeStatus } from "../src/money.js";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export function fixture() {
  const db = new Store(":memory:");
  const vault = new WalletVault(
    keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    "test-key",
  );
  const agents = new Agents(db, vault);
  const user = agents.createUser("Alice");
  return { db, vault, agents, user, budget: new Budget(db) };
}
test("net tax conserves integer wei and gives compute half of platform allocation", () => {
  assert.deepEqual(splitTax(10001n), {
    platform: 3000n,
    compute: 1500n,
    operations: 1500n,
    agent: 7001n,
  });
  assert.throws(() => splitTax(-1n));
  assert.equal(stakeDeficit(300000000000000000n, 0n, 1n, 0n), 0n);
  assert.equal(
    stakeDeficit(400000000000000000n, 100000000000000000n, 1n, 0n),
    200000000000000000n,
  );
  assert.equal(nodeStatus(0n, 300000000000000000n, false), "NO_COMPUTE");
  assert.equal(nodeStatus(1n, 0n, false), "OBSERVER");
  assert.equal(nodeStatus(1n, 300000000000000000n, false), "WORKER");
  assert.equal(nodeStatus(1n, 300000000000000000n, true), "JAILED");
});
test("launch identity is idempotent, request conflicts are rejected and keys stay encrypted", () => {
  const { db, agents, user, vault } = fixture();
  const a = agents.create(user.id, "request-1", {
    name: "Alpha",
    symbol: "ALP",
    meta: "bafy-test",
  });
  assert.equal(
    agents.create(user.id, "request-1", {
      name: "Alpha",
      symbol: "ALP",
      meta: "bafy-test",
    }).id,
    a.id,
  );
  assert.throws(
    () =>
      agents.create(user.id, "request-1", {
        name: "Changed",
        symbol: "ALP",
        meta: "bafy-test",
      }),
    /conflict/,
  );
  const wallet = db.get<any>("wallet", a.id)!;
  assert.ok(!JSON.stringify(wallet).includes("privateKey"));
  assert.equal(
    vault.withWallet(wallet, (w) => w.address),
    a.wallet,
  );
  assert.throws(() =>
    new WalletVault(
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "invalid",
      "wrong",
    ).withWallet(wallet, () => null),
  );
  assert.equal(agents.authenticate(user.token)?.id, user.id);
  assert.equal(agents.authenticate("wrong"), undefined);
  db.close();
});
test("budget reserves atomically, deduplicates credit and cannot settle above reservation", () => {
  const { db, budget } = fixture();
  budget.credit("a", "deposit:1", 100n);
  budget.credit("a", "deposit:1", 100n);
  assert.throws(() => budget.credit("b", "deposit:1", 100n), /conflict/);
  budget.reserve("a", "call:1", 70n);
  assert.equal(budget.available("a"), 30n);
  assert.throws(() => budget.reserve("a", "call:2", 31n), /budget/);
  assert.throws(() => budget.settle("call:1", 71n), /reservation/);
  budget.settle("call:1", 50n);
  budget.settle("call:1", 50n);
  assert.equal(budget.available("a"), 50n);
  assert.throws(() => budget.settle("call:1", 40n), /conflict/);
  assert.equal(budget.available("b"), 0n);
  db.close();
});
test("store transactions roll back partial writes", () => {
  const db = new Store(":memory:");
  assert.throws(() =>
    db.transaction(() => {
      db.put("x", "a", { v: 1 });
      throw Error("failure");
    }),
  );
  assert.equal(db.get("x", "a"), undefined);
  db.close();
});
