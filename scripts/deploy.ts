import { configureProxy } from "../src/network.js";
import {
  JsonRpcProvider,
  Wallet,
  ContractFactory,
  NonceManager,
  isAddress,
} from "ethers";
import { loadConfig } from "../src/config.js";
import { compileContracts } from "../src/contracts.js";
let provider: JsonRpcProvider | undefined;
try {
  configureProxy();
  const c = loadConfig(process.env.A2A_CONFIG);
  if (
    !c.chain.writesEnabled ||
    !c.chain.rpcUrl ||
    !process.env.A2A_OPERATOR_PRIVATE_KEY
  )
    throw Error("deployment configuration required");
  provider = new JsonRpcProvider(c.chain.rpcUrl, undefined, {
    cacheTimeout: -1,
  });
  if ((await provider.getNetwork()).chainId !== BigInt(c.chain.id))
    throw Error("Chain ID mismatch");
  const wallet = new Wallet(process.env.A2A_OPERATOR_PRIVATE_KEY, provider),
    signer = new NonceManager(wallet),
    platform = process.env.A2A_PLATFORM_ADDRESS ?? wallet.address;
  if (!isAddress(platform) || /^0x0{40}$/i.test(platform))
    throw Error("Invalid platform");
  const artifacts = compileContracts();
  for (const [name, args] of [
    ["AgentStake", [7 * 86400]],
    ["SplitterFactory", [platform]],
  ] as const) {
    const a = artifacts[name]!;
    const contract = await new ContractFactory(
      a.abi,
      a.bytecode,
      signer,
    ).deploy(...args);
    await contract.waitForDeployment();
    console.log(
      JSON.stringify({
        contract: name,
        address: await contract.getAddress(),
        chainId: c.chain.id,
      }),
    );
  }
} catch {
  console.error(
    JSON.stringify({
      error:
        "Deployment failed: check local configuration, expected chain, operator funding and RPC; inspect any already reported deployment before retrying",
    }),
  );
  process.exitCode = 1;
} finally {
  provider?.destroy();
}
