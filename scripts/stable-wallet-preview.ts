import { readFileSync } from "node:fs";
import { JsonRpcProvider } from "ethers";
import { z } from "zod";
import { Store } from "../src/store.js";
import {
  EthersPortfolioReader,
  PortfolioCollector,
  portfolioRegistrySchema,
} from "../src/portfolio-snapshot.js";
import {
  StableWalletPlanner,
  stableAllocationPreviewSchema,
} from "../src/stable-wallet-plan.js";
import { investmentRiskPolicySchema } from "../src/investment-risk.js";
import { configureProxy } from "../src/network.js";
let provider: JsonRpcProvider | undefined;
let db: Store | undefined;
try {
  const [file, database, ...extra] = process.argv.slice(2);
  if (!file || !database || extra.length || !process.env.A2A_PORTFOLIO_RPC_URL)
    throw Error("input, database and RPC required");
  const input = z
    .object({
      registry: portfolioRegistrySchema,
      request: z.unknown(),
      strategy: stableAllocationPreviewSchema,
      workerEligible: z.boolean(),
      policy: investmentRiskPolicySchema.default({}),
    })
    .strict()
    .parse(JSON.parse(readFileSync(file, "utf8")));
  configureProxy();
  provider = new JsonRpcProvider(process.env.A2A_PORTFOLIO_RPC_URL, undefined, {
    cacheTimeout: -1,
  });
  db = new Store(database);
  const snapshot = await new PortfolioCollector(
    db,
    new EthersPortfolioReader(provider),
    input.registry,
  ).collect(input.request);
  const plan = new StableWalletPlanner(db, input.policy).plan(
    snapshot.id,
    input.strategy,
    input.workerEligible,
    Date.now(),
  );
  process.stdout.write(
    JSON.stringify({ snapshotId: snapshot.id, plan }, null, 2) + "\n",
  );
  if (plan.status === "BLOCKED") process.exitCode = 1;
} catch {
  process.stderr.write(
    "Stable wallet preview failed; inspect persisted capture/plan status and local configuration.\n",
  );
  process.exitCode = 1;
} finally {
  db?.close();
  provider?.destroy();
}
