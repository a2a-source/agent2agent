import { z } from "zod";
import { Store } from "./store.js";
import { Budget } from "./budget.js";
import type { Agent } from "./agents.js";
import type { Epoch } from "./epochs.js";
import type { ChainState } from "./watcher.js";
import type { TxRecord } from "./chain.js";
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
interface Consumption {
  id: string;
  epochId: string;
  snapshotId: string;
  evaluatedAt: number;
  status: "PLANNED" | "REJECTED";
  reason: string;
  planId?: string;
  source?: { qspHash: string; confirmationHash: string };
  qualification?: {
    agent: Agent;
    chainState: ChainState;
    computeAvailable: string;
    minimumCompute: string;
  };
}
/** Internal trusted-DB consumer. Results are reference plans, never signing permission. */
export class ConfirmedStablePlans {
  readonly planner: StableWalletPlanner;
  constructor(
    readonly db: Store,
    readonly budget: Budget,
    readonly chainId: number,
    readonly stateMaxAgeMs: number,
    readonly minimumCompute: () => bigint | undefined,
    policy: unknown = {},
  ) {
    z.number().int().positive().safe().parse(chainId);
    z.number().int().positive().safe().parse(stateMaxAgeMs);
    this.planner = new StableWalletPlanner(db, policy);
  }
  consume(epochId: string, snapshotId: string, now: number): Consumption {
    z.string().min(1).max(128).parse(epochId);
    z.string().min(1).max(128).parse(snapshotId);
    z.number().int().nonnegative().safe().parse(now);
    const id = hash([
      "stable-qsp-consumption/1",
      this.chainId,
      epochId,
      snapshotId,
    ]);
    return this.db.transaction(() => {
      const prior = this.db.get<Consumption>("stable-qsp-consumption", id);
      if (prior) return prior;
      const r: Consumption = {
        id,
        epochId,
        snapshotId,
        evaluatedAt: now,
        status: "REJECTED",
        reason: "",
      };
      const save = (reason: string) => {
        r.reason = reason;
        this.db.insert("stable-qsp-consumption", id, r);
        return r;
      };
      const epoch = this.db.get<Epoch>("epoch", epochId),
        snapshot = this.db.get<PortfolioSnapshot>(
          "portfolio-snapshot",
          snapshotId,
        );
      if (!epoch || !snapshot) return save("SOURCE_MISSING");
      if (
        !epoch.confirmationRequired ||
        !epoch.confirmation ||
        !verifyPublishedEpoch(this.chainId, epoch)
      )
        return save("INVALID_CONFIRMATION");
      const parsed = qspV2Schema.safeParse(epoch.output);
      if (!parsed.success) return save("INVALID_QSP");
      const q = parsed.data;
      r.source = {
        qspHash: hash(q),
        confirmationHash: hash(epoch.confirmation),
      };
      if (
        q.context.chainId !== this.chainId ||
        snapshot.chainId !== this.chainId
      )
        return save("CHAIN_MISMATCH");
      const a = q.masterSummary.stableNetworkAllocation;
      if (!a) return save("NO_EXPLICIT_STABLE_ALLOCATION");
      const maxAge = q.context.policy.dataMaxAgeMs ?? 600000;
      let allocation: ReturnType<typeof validateStableNetworkAllocation>;
      try {
        allocation = validateStableNetworkAllocation(
          a,
          q.context,
          q.reports,
          now,
          maxAge,
        );
      } catch {
        return save("INVALID_STABLE_EVIDENCE_OR_TARGETS");
      }
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
        now >= validUntil
      )
        return save("SOURCE_EXPIRED_OR_FUTURE");
      const agent = this.db.get<Agent>("agent", snapshot.agent),
        state = this.db.get<ChainState>("chain-state", snapshot.agent);
      if (
        !agent ||
        agent.wallet.toLowerCase() !== snapshot.wallet.toLowerCase()
      )
        return save("REGISTERED_WALLET_MISMATCH");
      const min = this.minimumCompute(),
        available = this.budget.available(agent.id);
      if (min === undefined || min <= 0n)
        return save("COMPUTE_PRICE_UNAVAILABLE");
      if (
        !state?.known ||
        state.observedAt > now ||
        now - state.observedAt > this.stateMaxAgeMs
      )
        return save("STAKE_STATE_UNKNOWN_OR_STALE");
      r.qualification = {
        agent,
        chainState: state,
        computeAvailable: available.toString(),
        minimumCompute: min.toString(),
      };
      if (
        agent.launch !== "CONFIRMED" ||
        agent.jailed ||
        !agent.autoStake ||
        BigInt(state.bonded) < MIN_STAKE ||
        BigInt(state.exit) > 0n ||
        available < min
      )
        return save("WORKER_INELIGIBLE");
      const capture = this.db.get<any>("portfolio-capture", snapshot.requestId);
      if (
        capture?.status !== "DONE" ||
        capture.snapshotId !== snapshot.id ||
        capture.request?.agent !== agent.id ||
        capture.request?.wallet?.toLowerCase() !== agent.wallet.toLowerCase()
      )
        return save("CAPTURE_NOT_BOUND_TO_AGENT");
      const registryParsed = portfolioRegistrySchema.safeParse(
        capture.registry,
      );
      if (
        !registryParsed.success ||
        hash(capture.registry) !== snapshot.registryHash ||
        registryParsed.data.chainId !== this.chainId
      )
        return save("REGISTRY_MISMATCH");
      const registry = registryParsed.data;
      const mapped = registry.assets.filter(
        (x) => x.asset !== "native" && x.bucket !== "STABLE",
      );
      if (
        mapped.length !== q.context.universe.length ||
        mapped.some((x) => {
          const signed = q.context.universe.find(
            (y) => y.address.toLowerCase() === x.asset,
          );
          return (
            !signed ||
            signed.decimals !== x.decimals ||
            x.bucket !==
              (signed.marketSymbol === "BTCUSDT"
                ? "BTC"
                : signed.marketSymbol === "ETHUSDT"
                  ? "ETH"
                  : "BNB")
          );
        })
      )
        return save("SIGNED_ASSET_MAPPING_MISMATCH");
      const reserved = capture.request.reserved;
      if (
        !reserved ||
        Object.keys(reserved).length !== registry.assets.length ||
        registry.assets.some((x) => reserved[x.asset] !== "0")
      )
        return save("RESERVATION_RECONCILIATION_REQUIRED");
      const lock = this.db.get<{ expires: number }>(
        "sender-lock",
        agent.wallet.toLowerCase(),
      );
      if (lock && lock.expires > now)
        return save("WALLET_TRANSACTION_IN_PROGRESS");
      const unsettled = this.db
        .all<TxRecord>("transaction")
        .some(
          (t) =>
            t.sender.toLowerCase() === agent.wallet.toLowerCase() &&
            (t.state === "READY" ||
              (t.block !== undefined && t.block > snapshot.blockNumber)),
        );
      if (unsettled) return save("WALLET_TRANSACTION_RECONCILIATION_REQUIRED");
      let plan: ReturnType<StableWalletPlanner["plan"]>;
      try {
        plan = this.planner.plan(
          snapshotId,
          {
            version: "stable-allocation-preview/1",
            epoch: epoch.id,
            chainId: this.chainId,
            createdAt: q.createdAt,
            validUntil,
            targets: allocation.targets,
          },
          true,
          now,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "wallet plan conflict")
          return save("EXISTING_WALLET_PLAN_CONFLICT");
        throw error;
      }
      r.planId = plan.id;
      r.status = plan.status === "BLOCKED" ? "REJECTED" : "PLANNED";
      return save(
        plan.status === "BLOCKED" ? plan.reason : "CONFIRMED_REFERENCE_PLAN",
      );
    });
  }
}
