import { isAddress, keccak256, type AbstractProvider } from "ethers";
import type { Config } from "./config.js";

/** Errors safe to show operators; provider errors may contain RPC credentials. */
export class PreflightError extends Error {}

export async function inspectChain(
  chain: Config["chain"],
  provider: Pick<
    AbstractProvider,
    "getNetwork" | "getBlockNumber" | "getBlock" | "getCode"
  >,
) {
  let url: URL;
  try {
    url = new URL(chain.rpcUrl);
  } catch {
    throw new PreflightError("A valid HTTP(S) RPC URL is required");
  }
  if (!["https:", "http:"].includes(url.protocol))
    throw new PreflightError("A valid HTTP(S) RPC URL is required");
  const addresses = {
    flapPortal: chain.flapPortal,
    flapImplementation: chain.flapImplementation,
    factory: chain.factoryAddress,
    stake: chain.stakeAddress,
  };
  const missing: string[] = [];
  for (const [name, address] of Object.entries(addresses)) {
    if (!address) missing.push(name);
    else if (!isAddress(address))
      throw new PreflightError(`Invalid ${name} address`);
  }
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(chain.id))
    throw new PreflightError("Chain ID mismatch");
  const height = (await provider.getBlockNumber()) - chain.confirmations + 1;
  if (height < 0) throw new PreflightError("Confirmed snapshot unavailable");
  const block = await provider.getBlock(height);
  if (!block?.hash) throw new PreflightError("Confirmed snapshot unavailable");
  const contracts: Record<string, { address: string; codeHash: string }> = {};
  for (const [name, address] of Object.entries(addresses)) {
    if (!address) continue;
    const code = await provider.getCode(address, height);
    if (code === "0x") throw new PreflightError(`${name} has no deployed code`);
    contracts[name] = { address, codeHash: keccak256(code) };
  }
  if ((await provider.getBlock(height))?.hash !== block.hash)
    throw new PreflightError("Confirmed snapshot changed; retry preflight");
  return {
    readOnly: true,
    complete: missing.length === 0,
    missing,
    chainId: chain.id,
    height,
    blockHash: block.hash,
    contracts,
  };
}
