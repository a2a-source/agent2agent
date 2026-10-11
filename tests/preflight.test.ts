import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { inspectChain } from "../src/preflight.js";

const address = "0x1111111111111111111111111111111111111111";
function fixture() {
  const chain = loadConfig().chain;
  chain.rpcUrl = "https://rpc.example/secret-api-key";
  chain.confirmations = 3;
  const provider: any = {
    getNetwork: async () => ({ chainId: 97n }),
    getBlockNumber: async () => 12,
    getBlock: async (height: number) => ({
      number: height,
      hash: "0x" + "ab".repeat(32),
    }),
    getCode: async (_address: string, height: number) => {
      assert.equal(height, 10, "code must be read at the confirmed snapshot");
      return "0x6000";
    },
  };
  return { chain, provider };
}
test("partial preflight reports every missing contract without implying launch readiness", async () => {
  const { chain, provider } = fixture();
  chain.flapPortal = address;
  const result = await inspectChain(chain, provider);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ["flapImplementation", "factory", "stake"]);
  assert.equal(result.height, 10);
  assert.ok(result.contracts.flapPortal);
  assert.equal(result.contracts.flapPortal.address, address);
  assert.equal(result.readOnly, true);
  assert.ok(!JSON.stringify(result).includes("secret-api-key"));
});
test("preflight reports complete contract presence at one confirmed snapshot", async () => {
  const { chain, provider } = fixture();
  chain.flapPortal =
    chain.flapImplementation =
    chain.factoryAddress =
    chain.stakeAddress =
      address;
  const result = await inspectChain(chain, provider);
  assert.equal(result.complete, true);
  assert.deepEqual(result.missing, []);
  assert.equal(Object.keys(result.contracts).length, 4);
});
test("preflight rejects wrong chains and undeployed configured contracts", async () => {
  const { chain, provider } = fixture();
  provider.getNetwork = async () => ({ chainId: 56n });
  await assert.rejects(inspectChain(chain, provider), /Chain ID mismatch/);
  provider.getNetwork = async () => ({ chainId: 97n });
  chain.flapPortal = address;
  provider.getCode = async () => "0x";
  await assert.rejects(
    inspectChain(chain, provider),
    /flapPortal has no deployed code/,
  );
});
test("preflight rejects missing RPC and invalid contract addresses before contacting RPC", async () => {
  const { chain } = fixture();
  chain.rpcUrl = "";
  await assert.rejects(inspectChain(chain, {} as any), /RPC URL/);
  chain.rpcUrl = "https://rpc.example";
  chain.flapPortal = "not-an-address";
  await assert.rejects(inspectChain(chain, {} as any), /flapPortal address/);
});
test("preflight rejects unavailable and reorganized snapshots", async () => {
  const { chain, provider } = fixture();
  provider.getBlock = async () => null;
  await assert.rejects(inspectChain(chain, provider), /snapshot unavailable/);
  let reads = 0;
  provider.getBlock = async () => ({ hash: ++reads === 1 ? "0xaaa" : "0xbbb" });
  await assert.rejects(inspectChain(chain, provider), /snapshot changed/);
});

test("CLI fails promptly for missing RPC and unsupported flags without leaking provider details", async () => {
  const { spawnSync } = await import("node:child_process");
  const env = { ...process.env };
  delete env.A2A_CONFIG;
  delete env.A2A_HTTP_PROXY;
  for (const args of [["--require-complete"], ["--unknown"]]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/preflight.ts", ...args],
      { env, encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 1, result.stderr);
    const failure = JSON.parse(result.stderr.trim());
    assert.equal(failure.readOnly, true);
    assert.match(failure.error, args[0] === "--unknown" ? /Usage/ : /RPC URL/);
    assert.equal(result.stdout, "");
  }
});
