import { configureProxy } from "./network.js";
import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { WalletVault } from "./wallet.js";
import { Agents } from "./agents.js";
import { Budget } from "./budget.js";
import { Journal } from "./chain.js";
import { Watcher } from "./watcher.js";
import { FlapLauncher } from "./flap.js";
import { Epochs } from "./epochs.js";
import { Llm } from "./llm.js";
import { Runner } from "./runner.js";
import { Penalties } from "./penalties.js";
import { Scheduler } from "./scheduler.js";
import { createApi } from "./server.js";
configureProxy();
const config = loadConfig(process.env.A2A_CONFIG),
  adminToken =
    process.env.A2A_ADMIN_TOKEN ??
    readFileSync("var/admin-token", "utf8").trim();
const db = new Store(config.database),
  vault = new WalletVault(
    readFileSync(config.rsaPublicKey, "utf8"),
    readFileSync(config.rsaPrivateKey, "utf8"),
    config.rsaKeyId,
  ),
  agents = new Agents(db, vault),
  budget = new Budget(db),
  epochs = new Epochs(db);
const llm = new Llm(db, budget, config.llm, process.env.A2A_LLM_API_KEY ?? ""),
  runner = new Runner(agents, budget, epochs, llm, config),
  penalties = new Penalties(
    agents,
    epochs,
    config.chain.id,
    config.network.failureLimit,
    config.network.jailMs,
  );
let watcher: Watcher | undefined, launcher: FlapLauncher | undefined;
if (config.chain.rpcUrl) {
  const provider = new JsonRpcProvider(config.chain.rpcUrl, undefined, {
    cacheTimeout: -1,
  });
  const journal = new Journal(
    db,
    provider,
    config.chain.id,
    config.chain.writesEnabled,
  );
  if (config.chain.stakeAddress)
    watcher = new Watcher(
      agents,
      budget,
      journal,
      config.chain.stakeAddress,
      config.chain.confirmations,
      config.chain.fromBlock,
      BigInt(config.chain.gasReserveWei),
    );
  if (
    config.chain.flapPortal &&
    config.chain.flapImplementation &&
    config.chain.factoryAddress &&
    process.env.A2A_OPERATOR_PRIVATE_KEY
  ) {
    launcher = new FlapLauncher(
      agents,
      journal,
      new Wallet(process.env.A2A_OPERATOR_PRIVATE_KEY),
      {
        portal: config.chain.flapPortal,
        implementation: config.chain.flapImplementation,
        factory: config.chain.factoryAddress,
        taxDuration: config.chain.taxDuration,
        launchValueWei: config.chain.launchValueWei,
        confirmations: config.chain.confirmations,
      },
    );
  }
}
const scheduler = new Scheduler(runner, penalties, watcher, launcher),
  api = createApi({
    agents,
    budget,
    epochs,
    adminToken,
    watcher,
    launcher,
    penalties,
    tick: () => scheduler.tick(),
    minimumCompute: llm.maximum() * BigInt(config.roles.length + 2),
    stateMaxAgeMs: config.network.stateMaxAgeMs,
  });
api.requestTimeout = 30000;
api.headersTimeout = 15000;
const timer = setInterval(
  () =>
    void scheduler
      .tick()
      .catch(() =>
        console.error("Scheduler failed; inspect persisted service state."),
      ),
  config.network.pollMs,
);
api.listen(config.port, config.host, () =>
  console.log(
    `A2A v0.1 API listening on ${config.host}:${config.port}; chain writes ${config.chain.writesEnabled ? "enabled" : "disabled"}`,
  ),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    api.close(() => {
      void scheduler.stop().then(() => {
        db.close();
        process.exit(0);
      });
    });
  });
