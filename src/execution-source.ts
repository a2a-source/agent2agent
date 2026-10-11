import { z } from "zod";
import type { ConfirmedStablePlans } from "./confirmed-stable-plans.js";
import type { Agent } from "./agents.js";
import type { Epoch } from "./epochs.js";
import type { ChainState } from "./watcher.js";
import { hash } from "./protocol.js";
import { MIN_STAKE } from "./money.js";
import { verifyPublishedEpoch } from "./confirmation.js";
import { qspV2Schema } from "./qsp-v2.js";
import { validateStableNetworkAllocation } from "./stable-network-allocation.js";
import {
  portfolioRegistrySchema,
  type PortfolioSnapshot,
} from "./portfolio-snapshot.js";
import { StableWalletPlanner } from "./stable-wallet-plan.js";
import { Store } from "./store.js";
type Plan = ReturnType<StableWalletPlanner["plan"]>;
/** Revalidate authority at signing time; historical consumption is never permission. */
export function assertExecutionSource(
  consumer: ConfirmedStablePlans,
  planId: string,
  now: number,
): { plan: Plan; snapshot: PortfolioSnapshot } {
  z.number().int().nonnegative().safe().parse(now);
  const db = consumer.db;
  const plan = db.get<Plan>("stable-wallet-plan", planId);
  if (!plan || plan.id !== planId || plan.status !== "READY")
    throw Error("EXECUTION_PLAN_NOT_READY");
  const snapshot = db.get<PortfolioSnapshot>(
    "portfolio-snapshot",
    plan.snapshotId,
  );
  const epoch = db.get<Epoch>("epoch", plan.epoch);
  if (
    !snapshot ||
    !epoch ||
    !epoch.confirmationRequired ||
    !epoch.confirmation ||
    !verifyPublishedEpoch(consumer.chainId, epoch)
  )
    throw Error("INVALID_EXECUTION_CONFIRMATION");
  const q = qspV2Schema.parse(epoch.output);
  const consumptionId = hash([
    "stable-qsp-consumption/1",
    consumer.chainId,
    epoch.id,
    snapshot.id,
  ]);
  const consumed = db.get<any>("stable-qsp-consumption", consumptionId);
  if (
    !consumed ||
    consumed.id !== consumptionId ||
    consumed.status !== "PLANNED" ||
    consumed.planId !== plan.id ||
    consumed.epochId !== epoch.id ||
    consumed.snapshotId !== snapshot.id ||
    consumed.source?.qspHash !== hash(q) ||
    consumed.source?.confirmationHash !== hash(epoch.confirmation)
  )
    throw Error("EXECUTION_SOURCE_CHANGED");
  if (
    snapshot.id !== plan.snapshotId ||
    snapshot.chainId !== consumer.chainId ||
    q.context.chainId !== consumer.chainId ||
    plan.chainId !== consumer.chainId
  )
    throw Error("EXECUTION_CHAIN_MISMATCH");
  const allocation = validateStableNetworkAllocation(
    q.masterSummary.stableNetworkAllocation,
    q.context,
    q.reports,
    now,
    q.context.policy.dataMaxAgeMs ?? 600000,
  );
  const maxAge = q.context.policy.dataMaxAgeMs ?? 600000;
  const validUntil = Math.min(
    q.validUntil,
    allocation.validUntil,
    q.dataAt + maxAge,
    q.context.at + maxAge,
    snapshot.validUntil,
  );
  if (
    now < q.createdAt ||
    now < epoch.confirmation.confirmedAt ||
    now < snapshot.observedAt ||
    now < plan.evaluatedAt ||
    now >= validUntil ||
    now >= plan.validUntil
  )
    throw Error("EXECUTION_SOURCE_EXPIRED_OR_FUTURE");
  const strategy = {
    version: "stable-allocation-preview/1",
    epoch: epoch.id,
    chainId: consumer.chainId,
    createdAt: q.createdAt,
    validUntil,
    targets: allocation.targets,
  };
  if (
    hash(plan.strategy) !== hash(strategy) ||
    hash(plan.policy) !== hash(consumer.planner.policy)
  )
    throw Error("EXECUTION_PLAN_STRATEGY_MISMATCH");
  const agent = db.get<Agent>("agent", snapshot.agent);
  const state = db.get<ChainState>("chain-state", snapshot.agent);
  if (
    !agent ||
    agent.id !== snapshot.agent ||
    agent.wallet.toLowerCase() !== snapshot.wallet.toLowerCase()
  )
    throw Error("REGISTERED_WALLET_MISMATCH");
  const min = consumer.minimumCompute();
  if (min === undefined || min <= 0n) throw Error("COMPUTE_PRICE_UNAVAILABLE");
  if (
    !state?.known ||
    state.observedAt > now ||
    now - state.observedAt > consumer.stateMaxAgeMs
  )
    throw Error("STAKE_STATE_UNKNOWN_OR_STALE");
  if (
    agent.launch !== "CONFIRMED" ||
    agent.jailed ||
    !agent.autoStake ||
    BigInt(state.bonded) < MIN_STAKE ||
    BigInt(state.exit) > 0n ||
    consumer.budget.available(agent.id) < min
  )
    throw Error("WORKER_INELIGIBLE");
  const capture = db.get<any>("portfolio-capture", snapshot.requestId);
  if (
    capture?.status !== "DONE" ||
    capture.snapshotId !== snapshot.id ||
    capture.request?.agent !== agent.id ||
    capture.request?.wallet?.toLowerCase() !== agent.wallet.toLowerCase()
  )
    throw Error("CAPTURE_NOT_BOUND_TO_AGENT");
  const registry = portfolioRegistrySchema.parse(capture.registry);
  if (
    hash(capture.registry) !== snapshot.registryHash ||
    registry.chainId !== consumer.chainId
  )
    throw Error("EXECUTION_REGISTRY_MISMATCH");
  const mapped = registry.assets.filter(
    (a) => a.asset !== "native" && a.bucket !== "STABLE",
  );
  if (
    mapped.length !== q.context.universe.length ||
    mapped.some((a) => {
      const signed = q.context.universe.find(
        (s) => s.address.toLowerCase() === a.asset,
      );
      return (
        !signed ||
        signed.decimals !== a.decimals ||
        a.bucket !==
          (signed.marketSymbol === "BTCUSDT"
            ? "BTC"
            : signed.marketSymbol === "ETHUSDT"
              ? "ETH"
              : "BNB")
      );
    })
  )
    throw Error("SIGNED_ASSET_MAPPING_MISMATCH");
  // Recompute all derived orders, not only the input commitment. The isolated
  // store prevents cached plans and leaves the live database entirely untouched.
  const scratch = new Store(":memory:");
  try {
    scratch.put("portfolio-snapshot", snapshot.id, snapshot);
    scratch.put("portfolio-capture", snapshot.requestId, capture);
    const expected = new StableWalletPlanner(
      scratch,
      consumer.planner.policy,
    ).plan(snapshot.id, strategy, true, plan.evaluatedAt);
    if (hash(plan) !== hash(expected))
      throw Error("EXECUTION_PLAN_INTEGRITY_MISMATCH");
  } finally {
    scratch.close();
  }
  return { plan, snapshot };
}
