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

import { keccak256 } from "ethers";
const na = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const nativeAbi = new Interface([
  "function factory() view returns(address)",
  "function WETH() view returns(address)",
  "function getPair(address,address) view returns(address)",
  "function token0() view returns(address)",
  "function token1() view returns(address)",
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function swapExactETHForTokens(uint256,address[],address,uint256) payable returns(uint256[])",
]);
test("native quotes verify WETH and code at quote block and bind payable intent", async () => {
  const db = new Store(":memory:");
  let wrapped = na(3),
    code = "0x6000",
    now = 2000,
    canonical = true;
  const bh = "0x" + "ab".repeat(32);
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getBlockNumber: async () => 9,
    send: async () => ({ hash: canonical ? bh : "changed" }),
    getCode: async (target: string, block: number) => {
      assert.equal(block, 9);
      return target === na(3) ? code : "0x6000";
    },
    call: async (request: any) => {
      assert.equal(request.blockTag, 9);
      const call = nativeAbi.parseTransaction(request)!;
      const values: Record<string, any[]> = {
        factory: [na(2)],
        WETH: [wrapped],
        getPair: [na(5)],
        token0: [na(3)],
        token1: [na(4)],
        getReserves: [1000000n, 1000000n, 0],
        getAmountsOut: [[1000n, 997n]],
      };
      return nativeAbi.encodeFunctionResult(call.name, values[call.name]!);
    },
  };
  const config = {
    chainId: 97,
    router: na(1),
    factory: na(2),
    routerCodeHash: keccak256("0x6000"),
    factoryCodeHash: keccak256("0x6000"),
    tokens: [na(3), na(4)],
    wrappedNative: { address: na(3), codeHash: keccak256("0x6000") },
  };
  try {
    const dex = new V2Dex(db, provider, config, () => now);
    wrapped = na(8);
    await assert.rejects(
      dex.quote(na(6), "native", na(4), "1000"),
      /native|deployment/i,
    );
    wrapped = na(3);
    code = "0x6001";
    await assert.rejects(
      dex.quote(na(6), "native", na(4), "1000"),
      /native|deployment/i,
    );
    code = "0x6000";
    const q: any = await dex.quote(na(6), "native", na(4), "1000");
    assert.equal(q.version, "dex-v2-quote/2");
    assert.equal(q.inputAsset, "native");
    assert.equal(q.inputKind, "NATIVE");
    assert.deepEqual(q.path, [na(3), na(4)]);
    const request = await dex.request(q.id);
    assert.equal(request.value, 1000n);
    const decoded = nativeAbi.decodeFunctionData(
      "swapExactETHForTokens",
      request.data,
    );
    assert.equal(decoded[0], BigInt(q.minimumOut));
    assert.equal(decoded[2].toLowerCase(), na(6));
    await assert.rejects(
      dex.quote(na(6), "native", na(3), "1000"),
      /allowlisted/,
    );
    canonical = false;
    await assert.rejects(dex.request(q.id), /chain/);
    canonical = true;
    now = q.validUntil;
    await assert.rejects(dex.request(q.id), /expired/);
    assert.throws(
      () => new V2Dex(db, provider, { ...config, tokens: [na(4), na(8)] }),
      /allowlist/,
    );
    const { wrappedNative: omitted, ...legacyConfig } = config;
    const old = new V2Dex(db, provider, legacyConfig);
    await assert.rejects(old.quote(na(6), "native", na(4), "1000"), /native/);
  } finally {
    db.close();
  }
});
