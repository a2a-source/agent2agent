import { configureProxy } from "../src/network.js";
import { JsonRpcProvider, Wallet, ContractFactory } from "ethers";
import { loadConfig } from "../src/config.js";
import { compileContracts } from "../src/contracts.js";
configureProxy();
const c = loadConfig(process.env.A2A_CONFIG);
if (!c.chain.writesEnabled)
  throw Error("Explicit chain.writesEnabled configuration required");
if (!process.env.A2A_OPERATOR_PRIVATE_KEY)
  throw Error("A2A_OPERATOR_PRIVATE_KEY required");
const provider = new JsonRpcProvider(c.chain.rpcUrl);
if ((await provider.getNetwork()).chainId !== BigInt(c.chain.id))
  throw Error("Chain ID mismatch");
const signer = new Wallet(process.env.A2A_OPERATOR_PRIVATE_KEY, provider),
  platform = process.env.A2A_PLATFORM_ADDRESS ?? signer.address,
  artifacts = compileContracts();
for (const [name, args] of [
  ["AgentStake", [7 * 86400]],
  ["SplitterFactory", [platform]],
] as const) {
  const a = artifacts[name]!;
  const contract = await new ContractFactory(a.abi, a.bytecode, signer).deploy(
    ...args,
  );
  await contract.waitForDeployment();
  console.log(
    JSON.stringify({
      contract: name,
      address: await contract.getAddress(),
      chainId: c.chain.id,
    }),
  );
}
