import { FetchRequest, JsonRpcProvider } from "ethers";
import { loadConfig } from "../src/config.js";
import { configureProxy } from "../src/network.js";
import { inspectChain, PreflightError } from "../src/preflight.js";
let provider: JsonRpcProvider | undefined;
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--require-complete"))
    throw new PreflightError("Usage: preflight [--require-complete]");
  configureProxy();
  const config = loadConfig(process.env.A2A_CONFIG);
  if (!config.chain.rpcUrl) throw new PreflightError("RPC URL is required");
  const request = new FetchRequest(config.chain.rpcUrl);
  request.timeout = 15000;
  provider = new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
  const result = await inspectChain(config.chain, provider);
  console.log(JSON.stringify(result, null, 2));
  if (args.includes("--require-complete") && !result.complete)
    process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      readOnly: true,
      error:
        error instanceof PreflightError
          ? error.message
          : "Preflight failed: check local configuration and RPC connectivity",
    }),
  );
  process.exitCode = 1;
} finally {
  provider?.destroy();
}
