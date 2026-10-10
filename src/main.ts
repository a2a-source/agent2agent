import { RoundPerformanceCapture } from "./performance-capture.js";
import { InvestmentPlanning } from "./investment-planning.js";
import {
  PortfolioCollector,
  EthersPortfolioReader,
} from "./portfolio-snapshot.js";
import { ConfirmedStablePlans } from "./confirmed-stable-plans.js";
import { ChainlinkPrice } from "./price.js";
import { AgentRuntime } from "./agent-runtime.js";
import { TaxSettlement } from "./tax-settlement.js";
import { configureProxy } from "./network.js";
import { readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet } from "ethers";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { loadVault } from "./runtime-vault.js";
import { WalletMaintenance } from "./wallet-maintenance.js";
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
  vault = loadVault(config),
  agents = new Agents(db, vault),
  budget = new Budget(db),
  epochs = new Epochs(db);
const priceProvider = new JsonRpcProvider(
  config.chain.rpcUrl || undefined,
  undefined,
  { cacheTimeout: -1 },
);
const llm = new Llm(
    db,
    budget,
    config.llm,
    process.env.A2A_LLM_API_KEY ??
      (config.llm.apiKeyFile
        ? readFileSync(config.llm.apiKeyFile, "utf8").trim()
        : ""),
    new ChainlinkPrice(
      priceProvider,
      config.chain.id,
      config.llm.priceFeed,
      config.llm.priceMaxAgeSeconds,
      config.chain.confirmations,
    ),
  ),
  runner = new Runner(
    agents,
    budget,
    epochs,
    llm,
    config,
    {
      concurrency: config.recovery.researchConcurrency,
      maxAttempts: config.recovery.researchMaxAttempts,
    },
    new AgentRuntime(llm, config.agent),
  ),
  penalties = new Penalties(
    agents,
    epochs,
    config.chain.id,
    config.network.failureLimit,
    config.network.jailMs,
  );
let watcher: Watcher | undefined,
  launcher: FlapLauncher | undefined,
  settlement: TaxSettlement | undefined;
if (config.chain.rpcUrl) {
  const provider = new JsonRpcProvider(config.chain.rpcUrl, undefined, {
    cacheTimeout: -1,
  });
  const journal = new Journal(
    db,
    provider,
    config.chain.id,
    config.chain.writesEnabled,
    { ...config.recovery, confirmations: config.chain.confirmations },
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
      config.recovery.scanPagesPerTick,
    );
  if (
    config.chain.flapPortal &&
    config.chain.flapImplementation &&
    config.chain.factoryAddress &&
    process.env.A2A_OPERATOR_PRIVATE_KEY
  ) {
    settlement = new TaxSettlement(
      agents,
      journal,
      new Wallet(process.env.A2A_OPERATOR_PRIVATE_KEY),
      {
        ...config.settlement,
        factory: config.chain.factoryAddress,
        confirmations: config.chain.confirmations,
      },
    );
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
        dexThresh: config.chain.flapDexThreshold,
        confirmations: config.chain.confirmations,
      },
    );
  }
}
const maintenance = new WalletMaintenance(db, vault, {
  batchSize: config.recovery.walletBatchSize,
  backupDirectory: config.recovery.backupDirectory,
  backupIntervalMs: config.recovery.backupIntervalMs,
  maxBackups: config.recovery.maxBackups,
});
const performance = new RoundPerformanceCapture(db, config.chain.id);
const minimumCompute = () =>
  llm.priceReady()
    ? llm.maximum() *
      BigInt(config.agent.maxToolRounds + 1) *
      BigInt(config.roles.length + 2)
    : undefined;
const planning = config.investmentPlanning.enabled
  ? new InvestmentPlanning(
      db,
      new PortfolioCollector(
        db,
        new EthersPortfolioReader(priceProvider),
        config.investmentPlanning.registry,
      ),
      new ConfirmedStablePlans(
        db,
        budget,
        config.chain.id,
        config.network.stateMaxAgeMs,
        minimumCompute,
        config.investmentRisk,
      ),
      {
        ...config.investmentPlanning,
        gasReserveWei: config.chain.gasReserveWei,
      },
    )
  : undefined;
const scheduler = new Scheduler(
    runner,
    penalties,
    watcher,
    launcher,
    maintenance,
    settlement,
    performance,
    planning,
  ),
  api = createApi({
    agents,
    budget,
    epochs,
    performance: performance.ledger,
    adminToken,
    watcher,
    launcher,
    penalties,
    tick: () => scheduler.tick(),
    minimumCompute,
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
        priceProvider.destroy();
        process.exit(0);
      });
    });
  });
