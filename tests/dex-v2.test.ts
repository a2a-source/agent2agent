import test from "node:test";
import assert from "node:assert/strict";
import { quoteBounds } from "../src/dex-v2.js";
test("direct pool bounds use exact integers and round minimum output conservatively", () => {
  assert.deepEqual(quoteBounds(1000n, 997n, 1000000n, 1000000n, 50, 50), {
    minimumOut: 993n,
    impactBps: 30,
  });
});
test("illiquid, zero output, excessive impact and unsafe slippage are rejected", () => {
  assert.throws(
    () => quoteBounds(1000n, 900n, 1000000n, 1000000n, 50, 50),
    /impact/,
  );
  for (const args of [
    [0n, 1n, 100n, 100n, 50, 50],
    [1n, 0n, 100n, 100n, 50, 50],
    [1n, 1n, 0n, 100n, 50, 50],
    [1n, 1n, 100n, 100n, 10001, 50],
  ] as const)
    assert.throws(() =>
      quoteBounds(args[0], args[1], args[2], args[3], args[4], args[5]),
    );
});

import { Store } from "../src/store.js";
import { V2Dex } from "../src/dex-v2.js";
import { hash } from "../src/protocol.js";
import { Interface } from "ethers";
test("stored direct quote binds recipient, amounts and deadline; expiry and tampering fail closed", async () => {
  const db = new Store(":memory:");
  const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const blockHash = "0x" + "ab".repeat(32);
  let now = 2000;
  const provider = {
    getNetwork: async () => ({ chainId: 97n }),
    send: async () => ({ hash: blockHash }),
  };
  const dex = new V2Dex(
    db,
    provider as any,
    {
      chainId: 97,
      router: address(1),
      factory: address(2),
      routerCodeHash: blockHash,
      factoryCodeHash: blockHash,
      tokens: [address(3), address(4)],
    },
    () => now,
  );
  const body = {
    configHash: dex.configHash,
    chainId: 97,
    router: address(1),
    factory: address(2),
    pair: address(5),
    wallet: address(6),
    path: [address(3), address(4)],
    amountIn: "1000",
    amountOut: "997",
    minimumOut: "992",
    impactBps: 30,
    block: 1,
    blockHash,
    createdAt: 1000,
    validUntil: 3000,
  };
  const id = hash(body);
  db.put("dex-v2-quote", id, { ...body, id });
  try {
    const r = await dex.request(id);
    const iface = new Interface([
      "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    ]);
    const decoded = iface.decodeFunctionData(
      "swapExactTokensForTokens",
      r.data,
    );
    assert.equal(decoded[0], 1000n);
    assert.equal(decoded[1], 992n);
    assert.equal(decoded[3].toLowerCase(), address(6));
    assert.equal(decoded[4], 3n);
    now = 3000;
    await assert.rejects(dex.request(id), /expired/);
    now = 2000;
    db.put("dex-v2-quote", id, { ...body, id, wallet: address(7) });
    await assert.rejects(dex.request(id), /invalid/);
  } finally {
    db.close();
  }
});
test("fractional spot value cannot conceal excessive impact", () => {
  assert.throws(() => quoteBounds(1n, 1n, 100n, 199n, 50, 50), /impact/);
});
