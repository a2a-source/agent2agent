import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet, Interface } from "ethers";
import { Store } from "../src/store.js";
import { Journal } from "../src/chain.js";
import { TaxSettlement } from "../src/tax-settlement.js";
function setup() {
  const db = new Store(":memory:"),
    wallet = Wallet.createRandom();
  const a = {
    id: "agent",
    launch: "CONFIRMED",
    token: wallet.address,
    splitter: wallet.address,
    wallet: wallet.address,
  };
  db.put("transaction", "launch:agent", {
    id: "launch:agent",
    state: "CONFIRMED",
    block: 100,
  });
  let balance = 10000n;
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getBlockNumber: async () => 100,
    getBlock: async () => ({ hash: "canonical" }),
    getBalance: async () => balance,
    getTransactionCount: async () => 10,
    call: async () => "0x",
  };
  const cfg = {
    factory: wallet.address,
    confirmations: 1,
    minRevenueWei: "1",
    maxFeeWei: "10",
    dailyBudgetWei: "100",
    gasReserveWei: "100",
    intervalMs: 10,
  };
  const pending = { processor: wallet.address, dispatch: 1000n, flush: 0n };
  const sent: string[] = [];
  function collector(overrides = {}) {
    const c = new TaxSettlement(
      { db, list: () => [a] } as any,
      new Journal(db, provider, 97, true),
      wallet,
      { ...cfg, ...overrides },
    );
    (c as any).inspect = async () => ({ ...pending });
    c.journal.confirmed = async (id) =>
      db.get<any>("transaction", id)?.state === "CONFIRMED";
    c.journal.reserved = () => 0n;
    c.journal.send = async (id, _sender, _signer, request) => {
      const action = new Interface([
        "function flush()",
        "function dispatch()",
      ]).parseTransaction({ data: request.data as string })!.name;
      sent.push(action);
      const row: any = { id, state: "CONFIRMED", block: 100 };
      db.put("transaction", id, row);
      return row;
    };
    return c;
  }
  return {
    db,
    wallet,
    provider,
    cfg,
    pending,
    sent,
    collector,
    setBalance: (b: bigint) => (balance = b),
  };
}
test("unsigned settlement backlog must recheck current-day budget and operator reserve", async () => {
  const x = setup();
  try {
    const first = x.collector();
    first.journal.send = async () => {
      throw Error("sender busy");
    };
    await first.tick(1000);
    assert.ok(x.db.get<any>("tax-settlement", "agent").id);
    await x.collector({ dailyBudgetWei: "1" }).tick(86401000);
    assert.equal(
      x.sent.length,
      0,
      "yesterday's unsigned operation must not bypass today's budget",
    );
    x.setBalance(0n);
    await x.collector().tick(86402000);
    assert.equal(x.sent.length, 0, "reserve must be rechecked");
  } finally {
    x.db.close();
  }
});
test("unproductive flush backs off and does not starve pending dispatch", async () => {
  const x = setup();
  try {
    x.pending.flush = 1000n;
    const c = x.collector();
    await c.tick(1000);
    await c.tick(2000);
    await c.tick(3000);
    assert.deepEqual(x.sent, ["flush", "dispatch"]);
  } finally {
    x.db.close();
  }
});
test("canonical reverted operation can retire after recovery even when operator nonce advanced", async () => {
  const x = setup();
  try {
    const raw = await x.wallet.signTransaction({
      chainId: 97,
      nonce: 1,
      gasLimit: 21000,
      gasPrice: 1,
      to: x.wallet.address,
    });
    x.db.put("transaction", "tax:agent:0", {
      id: "tax:agent:0",
      sender: x.wallet.address,
      state: "REVERTED",
      raw,
      hash: "old",
      recovery: { logicalAttempts: 1 },
    });
    x.db.put("tax-settlement", "agent", {
      sequence: 0,
      nextAt: 0,
      id: "tax:agent:0",
      target: x.wallet.address,
      action: "dispatch",
      before: "1000",
      maxFeeWei: "10",
    });
    x.provider.getTransactionReceipt = async () => ({
      status: 0,
      blockNumber: 90,
      blockHash: "canonical",
      confirmations: async () => 20,
    });
    const c = x.collector();
    await c.tick(100000);
    assert.equal(
      x.sent.length,
      0,
      "retirement must not immediately bypass cooldown",
    );
    await c.tick(101000);
    assert.ok(x.db.get("transaction", "tax:agent:1"));
    assert.equal(x.sent.length, 1);
  } finally {
    x.db.close();
  }
});
