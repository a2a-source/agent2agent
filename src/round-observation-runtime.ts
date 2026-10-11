import type { JsonRpcProvider } from "ethers";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import {
  EthersPortfolioReader,
  PortfolioCollector,
} from "./portfolio-snapshot.js";
import { proveRoundNoExternalFlow } from "./round-cashflow.js";
import {
  RoundObservationService,
  type RoundObservationAdapters,
} from "./round-observation.js";
import { RoundPerformanceCapture } from "./performance-capture.js";
import type { Epoch } from "./epochs.js";
/** Read-only settlement readiness. Never schedules planning or execution. */
export function roundSettlementReady(
  db: Store,
  chainId: number,
  executionEnabled: boolean,
  epoch: Epoch,
): boolean {
  if (
    !executionEnabled ||
    epoch.status === "FAILED" ||
    !(epoch.output as any)?.masterSummary?.stableNetworkAllocation
  )
    return true;
  const discovery = db.get<any>(
    "investment-planning-epoch",
    hash([chainId, epoch.id]),
  );
  if (!discovery) return false;
  if (discovery.status === "SKIPPED") return true;
  const planning = db
    .all<any>("investment-planning-job")
    .filter((j) => j.epoch === epoch.id);
  if (planning.some((j) => !["DONE", "FAILED", "EXPIRED"].includes(j.status)))
    return false;
  const jobs = db
    .all<any>("investment-execution-job")
    .filter((j) => j.chainId === chainId && j.roundId === epoch.id);
  if (jobs.some((j) => !["DONE", "ABORTED"].includes(j.status))) return false;
  return planning.every((p) => {
    const plan = p.planId ? db.get<any>("stable-wallet-plan", p.planId) : null;
    return (
      !plan ||
      plan.status !== "READY" ||
      jobs.some((j) => j.planId === p.planId)
    );
  });
}
export function createRoundObservationCapture(
  db: Store,
  options: {
    chainId: number;
    registry: unknown | null;
    provider?: JsonRpcProvider;
    executionEnabled: boolean;
    clock?: () => number;
    adapters?: RoundObservationAdapters;
  },
): RoundPerformanceCapture {
  const clock = options.clock ?? Date.now;
  let adapters = options.adapters;
  if (!adapters && options.registry && options.provider) {
    const provider = options.provider,
      reader = new EthersPortfolioReader(provider),
      collector = new PortfolioCollector(db, reader, options.registry, clock);
    adapters = {
      collector,
      selectBoundary: async (terminalAt, afterBlock) => {
        if ((await reader.chainId()) !== options.chainId)
          throw Error("OBSERVATION_CHAIN_MISMATCH");
        const tip = await reader.tip(),
          number = tip - collector.registry.confirmations;
        if (number < 0) return null;
        const block = await reader.block(number);
        if (
          block.timestamp * 1000 < terminalAt ||
          block.timestamp * 1000 > clock() ||
          (afterBlock !== null && number <= afterBlock)
        )
          return null;
        return {
          blockNumber: number,
          blockHash: block.hash,
          blockTimeMs: block.timestamp * 1000,
        };
      },
      settlementReady: (e) =>
        roundSettlementReady(db, options.chainId, options.executionEnabled, e),
      prove: (a, b) =>
        proveRoundNoExternalFlow(
          db,
          provider,
          a,
          b,
          collector.registry.confirmations,
        ),
    };
  }
  return new RoundPerformanceCapture(
    db,
    options.chainId,
    new RoundObservationService(db, options.chainId, adapters, {}, clock),
  );
}
