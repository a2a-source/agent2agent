import { JsonRpcProvider, keccak256 } from "ethers";
import { loadConfig } from "../src/config.js";
import { configureProxy } from "../src/network.js";
configureProxy();
const c = loadConfig(process.env.A2A_CONFIG),
  p = new JsonRpcProvider(c.chain.rpcUrl, undefined, { cacheTimeout: -1 });
try {
  const network = await p.getNetwork();
  if (network.chainId !== BigInt(c.chain.id)) throw Error("Chain ID mismatch");
  const height = await p.getBlockNumber(),
    block = await p.getBlock(height);
  const contracts: Record<string, unknown> = {};
  for (const [name, address] of Object.entries({
    flapPortal: c.chain.flapPortal,
    flapImplementation: c.chain.flapImplementation,
    factory: c.chain.factoryAddress,
    stake: c.chain.stakeAddress,
  })) {
    if (!address) continue;
    const code = await p.getCode(address, height);
    if (code === "0x") throw Error(`${name} has no deployed code`);
    contracts[name] = { address, codeHash: keccak256(code) };
  }
  console.log(
    JSON.stringify(
      {
        readOnly: true,
        chainId: c.chain.id,
        height,
        blockHash: block?.hash,
        contracts,
      },
      null,
      2,
    ),
  );
} finally {
  p.destroy();
}
