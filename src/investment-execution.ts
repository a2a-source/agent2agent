import { proveExecutionNoExternalFlow } from "./execution-cashflow.js";
import { randomUUID } from "node:crypto";
import { Contract, Interface, type HDNodeWallet, type Wallet } from "ethers";
import { z } from "zod";
import { Store } from "./store.js";
import { hash } from "./protocol.js";
import { Journal, type TxRecord } from "./chain.js";
import { V2Dex, type V2Quote } from "./dex-v2.js";
import { recordV2Fill } from "./dex-v2-fill.js";
import {
  PortfolioCollector,
  EthersPortfolioReader,
  portfolioRegistrySchema,
  type PortfolioSnapshot,
} from "./portfolio-snapshot.js";
import { ConfirmedStablePlans } from "./confirmed-stable-plans.js";
import { StableWalletPlanner } from "./stable-wallet-plan.js";
import { WalletReservations } from "./wallet-reservations.js";
import { InvestmentRisk } from "./investment-risk.js";
import { assertExecutionSource } from "./execution-source.js";
import { ExecutionFeedback } from "./execution-feedback.js";
import { verifyPublishedEpoch } from "./confirmation.js";
import { qspV2Schema } from "./qsp-v2.js";
import { validateStableNetworkAllocation } from "./stable-network-allocation.js";
import type { Epoch } from "./epochs.js";

type Plan = ReturnType<StableWalletPlanner["plan"]>;
type Registry = PortfolioCollector["registry"];
const executionSucceeded = (reason: string | undefined) =>
  reason === "EXECUTED" || reason === "NO_ACTION";
const erc20 = new Interface([
  "function approve(address,uint256) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
]);
import { executionConfigSchema } from "./execution-config.js";
export interface ExecutionOrder {
  side: "BUY" | "SELL";
  bucket: "BTC" | "ETH" | "BNB";
  notionalMicros: string;
  input: string;
  output: string;
  amountIn: string;
  approvalId: string;
  swapId: string;
  quoteId?: string;
  fillId?: string;
}
/** Use confirmed oracle units. Native currency requires a separate wrapping adapter. */
export function compileExecutionOrders(
  plan: Pick<Plan, "orders">,
  snapshot: PortfolioSnapshot,
  registry: Registry,
): ExecutionOrder[] {
  const stable = registry.assets.filter(
    (a) => a.bucket === "STABLE" && a.asset !== "native",
  );
  if (stable.length !== 1) throw Error("one reserve asset required");
  return plan.orders.map((o, index) => {
    const volatile = registry.assets.filter(
      (a) => a.bucket === o.bucket && a.asset !== "native",
    );
    if (volatile.length !== 1)
      throw Error("unambiguous ERC20 underlying required");
    const input = o.side === "BUY" ? stable[0]! : volatile[0]!,
      output = o.side === "BUY" ? volatile[0]! : stable[0]!;
    const h = snapshot.holdings.find((h) => h.asset === input.asset);
    if (!h || BigInt(h.priceMicros) <= 0n)
      throw Error("input valuation missing");
    const units =
      (BigInt(o.notionalMicros) * 10n ** BigInt(input.decimals)) /
      BigInt(h.priceMicros);
    if (
      units <= 0n ||
      units > BigInt(h.balance) - BigInt(h.reserved) - BigInt(h.gasExcluded)
    )
      throw Error("insufficient input units");
    return {
      ...o,
      input: input.asset,
      output: output.asset,
      amountIn: String(units),
      approvalId: String(index) + ":approve",
      swapId: String(index) + ":swap",
    };
  });
}
export interface ExecutionJob {
  id: string;
  planId: string;
  roundId: string;
  chainId: number;
  agent: string;
  wallet: string;
  status: "NEW" | "ACTIVE" | "RECONCILING" | "DONE" | "ABORTED";
  orders: ExecutionOrder[];
  index: number;
  attempts: number;
  nextAt: number;
  owner?: string;
  leaseUntil?: number;
  reservationId?: string;
  cycleId?: string;
  reason?: string;
  lastError?: string;
  closingSnapshotId?: string;
  observationId?: string;
  configHash: string;
}
/** Durable bounded-step coordinator. A pending signed intent is reconciled, never re-created. */
export class InvestmentExecution {
  private busy = false;
  private owners = new Map<string, string>();
  readonly reservations: WalletReservations;
  readonly feedback: ExecutionFeedback;
  readonly options: z.infer<typeof executionConfigSchema>;
  readonly configHash: string;
  constructor(
    readonly db: Store,
    readonly consumer: ConfirmedStablePlans,
    readonly collector: PortfolioCollector,
    readonly dex: V2Dex,
    readonly journal: Journal,
    readonly signer: (agent: string) => Wallet | HDNodeWallet,
    options: unknown = {},
    readonly gasReserveWei = "1000000000000000",
    readonly clock = Date.now,
  ) {
    this.options = executionConfigSchema.parse(options);
    if (
      dex.config.chainId !== consumer.chainId ||
      collector.registry.chainId !== consumer.chainId ||
      journal.chainId !== consumer.chainId
    )
      throw Error("execution chain mismatch");
    this.configHash = hash({
      registry: collector.registry,
      dex: dex.config,
      options: this.options,
      gasReserveWei,
    });
    if (!db.get("investment-execution-config", this.configHash))
      db.insert("investment-execution-config", this.configHash, {
        registry: collector.registry,
        dex: dex.config,
        options: this.options,
        gasReserveWei,
      });
    this.reservations = new WalletReservations(db);
    this.feedback = new ExecutionFeedback(db);
  }
  /** Installed in Journal: synchronous, repeated immediately before signed bytes are persisted. */
  assertCanSign(planId: string) {
    const j = this.db.get<ExecutionJob>(
      "investment-execution-job",
      hash(["investment-execution/1", planId]),
    );
    if (
      !this.options.enabled ||
      !j ||
      j.status !== "ACTIVE" ||
      j.owner !== this.owners.get(j.id) ||
      (j.leaseUntil ?? 0) <= this.clock() ||
      j.configHash !== this.configHash
    )
      throw Error("execution lease unavailable");
    assertExecutionSource(this.consumer, planId, this.clock());
  }
  private save(j: ExecutionJob) {
    const current = this.db.get<ExecutionJob>("investment-execution-job", j.id);
    if (
      !current ||
      current.owner !== this.owners.get(j.id) ||
      (current.leaseUntil ?? 0) <= this.clock()
    )
      throw Error("execution lease lost");
    this.db.put("investment-execution-job", j.id, j);
  }
  private discover() {
    for (const p of this.db.all<Plan>("stable-wallet-plan")) {
      if (
        !["READY", "NO_ACTION"].includes(p.status) ||
        p.chainId !== this.consumer.chainId
      )
        continue;
      const id = hash(["investment-execution/1", p.id]);
      if (!this.db.get("investment-execution-job", id))
        this.db.insert("investment-execution-job", id, {
          id,
          planId: p.id,
          roundId: p.epoch,
          chainId: p.chainId,
          agent: p.agent,
          wallet: p.wallet,
          status: "NEW",
          orders: [],
          index: 0,
          attempts: 0,
          nextAt: this.clock(),
          configHash: this.configHash,
        } satisfies ExecutionJob);
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.options.enabled) this.discover();
      let count = 0;
      // A failed batch must yield to jobs that have waited longer, even when
      // every retry is due again before the next scheduler poll.
      const candidates = this.db
        .all<ExecutionJob>("investment-execution-job")
        .sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id));
      for (const old of candidates) {
        if (
          old.chainId !== this.consumer.chainId ||
          ["DONE", "ABORTED"].includes(old.status) ||
          old.nextAt > this.clock() ||
          (old.leaseUntil ?? 0) > this.clock() ||
          count >= this.options.maxJobsPerTick
        )
          continue;
        const j = this.db.transaction(() => {
          const row = this.db.get<ExecutionJob>(
            "investment-execution-job",
            old.id,
          )!;
          if ((row.leaseUntil ?? 0) > this.clock()) return;
          const claim = {
            ...row,
            owner: randomUUID(),
            leaseUntil: this.clock() + this.options.leaseMs,
            attempts: row.attempts + 1,
          };
          this.db.put("investment-execution-job", claim.id, claim);
          return claim;
        });
        if (!j) continue;
        count++;
        this.owners.set(j.id, j.owner!);
        try {
          await this.step(j);
        } catch {
          // Error strings may include provider URLs. Persist only bounded protocol reason codes.
          const latest = this.db.get<ExecutionJob>(
            "investment-execution-job",
            j.id,
          )!;
          if (
            latest.owner === j.owner &&
            (latest.leaseUntil ?? 0) > this.clock()
          )
            this.db.put("investment-execution-job", j.id, {
              ...latest,
              lastError: "EXECUTION_RETRY_PENDING",
            });
        } finally {
          const latest = this.db.get<ExecutionJob>(
            "investment-execution-job",
            j.id,
          )!;
          if (latest.owner === j.owner)
            this.db.put("investment-execution-job", j.id, {
              ...latest,
              leaseUntil: 0,
              nextAt: this.clock() + this.options.retryMs,
            });
          this.owners.delete(j.id);
        }
      }
      this.finishRounds();
    } finally {
      this.busy = false;
    }
  }
  private initialize(j: ExecutionJob) {
    const { plan, snapshot } = assertExecutionSource(
      this.consumer,
      j.planId,
      this.clock(),
    );
    if (snapshot.registryHash !== hash(this.collector.registry))
      throw Error("execution registry differs from signed snapshot");
    if (this.openingGasReserve(snapshot) !== this.gasReserveWei)
      throw Error("execution gas reserve differs from opening capture");
    const orders = compileExecutionOrders(
      plan,
      snapshot,
      this.collector.registry,
    ).map((o) => ({
      ...o,
      approvalId: hash([j.id, o.approvalId]),
      swapId: hash([j.id, o.swapId]),
    }));
    if (!orders.length) throw Error("empty execution");
    const native = snapshot.holdings.find((h) => h.asset === "native")!;
    const gas =
      (BigInt(this.options.maxTransactionFeeWei) *
        2n *
        BigInt(native.priceMicros) +
        10n ** 18n -
        1n) /
      10n ** 18n;
    if (
      orders.some(
        (o) =>
          gas * 10000n >
          BigInt(o.notionalMicros) * BigInt(plan.policy.maxGasBps),
      )
    )
      throw Error("gas exceeds economic limit");
    const amounts: Record<string, bigint> = {
      native:
        BigInt(this.options.maxTransactionFeeWei) * BigInt(orders.length * 2),
    };
    for (const o of orders)
      amounts[o.input] = (amounts[o.input] ?? 0n) + BigInt(o.amountIn);
    this.db.transaction(() => {
      const reservation = this.reservations.reserve(
        {
          id: hash(["execution-reservation/1", j.id]),
          planId: plan.id,
          transactionIds: orders.flatMap((o) => [o.approvalId, o.swapId]),
          amounts: Object.fromEntries(
            Object.entries(amounts).map(([a, n]) => [a, String(n)]),
          ),
        },
        this.clock(),
      );
      const cycle = new InvestmentRisk(this.db, plan.policy).open({
        epoch: plan.epoch,
        agent: plan.agent,
        wallet: plan.wallet,
        chainId: plan.chainId,
        at: snapshot.observedAt,
        validUntil: plan.validUntil,
        complete: true,
        navMicros: snapshot.navMicros,
        stableValueMicros: snapshot.stableValueMicros,
        availableStableMicros: snapshot.availableStableMicros,
        exposures: snapshot.exposures,
      });
      j.orders = orders;
      j.reservationId = reservation.id;
      j.cycleId = cycle.id;
      j.status = "ACTIVE";
      this.db.insert("investment-execution-reservation", reservation.id, {
        planId: plan.id,
        jobId: j.id,
      });
      this.save(j);
    });
  }
  /** Observation only: verify the consumed signed source without granting signing authority. */
  private initializeNoAction(j: ExecutionJob, plan: Plan) {
    const now = this.clock(),
      snapshot = this.db.get<PortfolioSnapshot>(
        "portfolio-snapshot",
        plan.snapshotId,
      ),
      epoch = this.db.get<Epoch>("epoch", plan.epoch);
    if (
      !snapshot ||
      !epoch ||
      !epoch.confirmationRequired ||
      !epoch.confirmation ||
      !verifyPublishedEpoch(this.consumer.chainId, epoch) ||
      plan.id !== j.planId ||
      plan.status !== "NO_ACTION" ||
      plan.orders.length ||
      plan.chainId !== j.chainId ||
      plan.epoch !== j.roundId ||
      plan.agent !== j.agent ||
      plan.wallet !== j.wallet ||
      snapshot.chainId !== j.chainId ||
      snapshot.agent !== j.agent ||
      snapshot.wallet !== j.wallet ||
      snapshot.registryHash !== hash(this.collector.registry) ||
      now < plan.evaluatedAt ||
      now < snapshot.observedAt ||
      now >= plan.validUntil
    )
      throw Error("invalid NO_ACTION observation source");
    const { id, ...body } = snapshot;
    if (id !== plan.snapshotId || hash(body) !== id)
      throw Error("NO_ACTION snapshot integrity");
    if (this.openingGasReserve(snapshot) !== this.gasReserveWei)
      throw Error("NO_ACTION gas reserve differs from opening capture");
    const q = qspV2Schema.parse(epoch.output),
      consumptionId = hash([
        "stable-qsp-consumption/1",
        j.chainId,
        epoch.id,
        snapshot.id,
      ]),
      consumed = this.db.get<any>("stable-qsp-consumption", consumptionId),
      capture = this.db.get<any>("portfolio-capture", snapshot.requestId);
    if (
      q.context.chainId !== j.chainId ||
      now < q.createdAt ||
      now < epoch.confirmation.confirmedAt ||
      consumed?.id !== consumptionId ||
      consumed.status !== "PLANNED" ||
      consumed.planId !== plan.id ||
      consumed.epochId !== epoch.id ||
      consumed.snapshotId !== snapshot.id ||
      consumed.source?.qspHash !== hash(q) ||
      consumed.source?.confirmationHash !== hash(epoch.confirmation) ||
      capture?.status !== "DONE" ||
      capture.snapshotId !== snapshot.id ||
      capture.request?.agent !== j.agent ||
      capture.request?.wallet?.toLowerCase() !== j.wallet ||
      hash(capture.registry) !== snapshot.registryHash
    )
      throw Error("NO_ACTION consumption evidence mismatch");
    const maxAge = q.context.policy.dataMaxAgeMs ?? 600000,
      allocation = validateStableNetworkAllocation(
        q.masterSummary.stableNetworkAllocation,
        q.context,
        q.reports,
        now,
        maxAge,
      ),
      strategy = {
        version: "stable-allocation-preview/1",
        epoch: epoch.id,
        chainId: j.chainId,
        createdAt: q.createdAt,
        validUntil: Math.min(
          q.validUntil,
          allocation.validUntil,
          q.dataAt + maxAge,
          q.context.at + maxAge,
          snapshot.validUntil,
        ),
        targets: allocation.targets,
      };
    if (
      hash(plan.strategy) !== hash(strategy) ||
      hash(plan.policy) !== hash(this.consumer.planner.policy)
    )
      throw Error("NO_ACTION signed strategy mismatch");
    const scratch = new Store(":memory:");
    try {
      scratch.put("portfolio-snapshot", snapshot.id, snapshot);
      scratch.put("portfolio-capture", snapshot.requestId, capture);
      const expected = new StableWalletPlanner(scratch, plan.policy).plan(
        snapshot.id,
        strategy,
        true,
        plan.evaluatedAt,
      );
      if (hash(expected) !== hash(plan))
        throw Error("NO_ACTION plan integrity");
    } finally {
      scratch.close();
    }
    j.status = "RECONCILING";
    j.reason = "NO_ACTION";
    this.save(j);
  }
  private openingGasReserve(opening: PortfolioSnapshot): string {
    const capture = this.db.get<any>("portfolio-capture", opening.requestId);
    const { id, ...body } = opening;
    const reserve = capture?.request?.gasReserveWei;
    if (
      hash(body) !== id ||
      capture?.status !== "DONE" ||
      capture.snapshotId !== id ||
      hash([opening.chainId, capture.request?.id]) !== opening.requestId ||
      capture.request?.agent !== opening.agent ||
      capture.request?.wallet?.toLowerCase() !== opening.wallet ||
      hash(capture.registry) !== opening.registryHash ||
      typeof reserve !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(reserve) ||
      opening.holdings.filter((h) => h.asset === "native").length !== 1 ||
      opening.holdings.find((h) => h.asset === "native")?.gasExcluded !==
        reserve
    )
      throw Error("opening capture gas reserve unavailable or inconsistent");
    return reserve;
  }
  /** Preserve deployment identity and the reserve measured by the opening capture. */
  private recoverySettings(j: ExecutionJob) {
    const deployment = this.db.get<any>(
      "investment-execution-config",
      j.configHash,
    );
    const plan = this.db.get<Plan>("stable-wallet-plan", j.planId);
    const opening =
      plan &&
      this.db.get<PortfolioSnapshot>("portfolio-snapshot", plan.snapshotId);
    const capture =
      opening && this.db.get<any>("portfolio-capture", opening.requestId);
    if (
      !deployment ||
      hash(deployment) !== j.configHash ||
      !opening ||
      capture?.status !== "DONE" ||
      capture.snapshotId !== opening.id ||
      hash(capture.registry) !== opening.registryHash ||
      hash(deployment.registry) !== opening.registryHash ||
      opening.chainId !== j.chainId ||
      opening.wallet !== j.wallet
    )
      throw Error("original execution deployment unavailable or inconsistent");
    const registry = portfolioRegistrySchema.parse(deployment.registry);
    if (
      registry.chainId !== j.chainId ||
      typeof deployment.gasReserveWei !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(deployment.gasReserveWei)
    )
      throw Error("invalid original execution recovery settings");
    return {
      registry,
      gasReserveWei: this.openingGasReserve(opening),
      opening,
    };
  }
  private async final(id: string, confirmations: number) {
    return (await this.journal.terminal(id, confirmations)) !== undefined;
  }
  private async step(j: ExecutionJob) {
    if (j.status === "NEW") {
      if (!this.options.enabled) {
        j.status = "ABORTED";
        j.reason = "EXECUTION_DISABLED";
        this.save(j);
        return;
      }
      const noAction = this.db.get<Plan>("stable-wallet-plan", j.planId);
      if (noAction?.status === "NO_ACTION") {
        try {
          this.initializeNoAction(j, noAction);
        } catch {
          j.status = "ABORTED";
          j.reason = "NO_ACTION_SOURCE_INVALID";
          this.save(j);
        }
        return;
      }
      try {
        this.initialize(j);
      } catch {
        // No signed intent exists before initialize commits. Retry temporary dependencies until source expiry.
        const p = this.db.get<Plan>("stable-wallet-plan", j.planId);
        if (
          !p ||
          this.clock() >= p.validUntil ||
          j.configHash !== this.configHash
        ) {
          j.status = "ABORTED";
          j.reason = "SOURCE_WINDOW_CLOSED";
          this.save(j);
        } else throw Error("initialization unavailable");
      }
      return;
    }
    if (j.status === "RECONCILING") {
      await this.reconcile(j);
      return;
    }
    const confirmations = this.recoverySettings(j).registry.confirmations;
    const o = j.orders[j.index];
    if (!o) {
      j.status = "RECONCILING";
      j.reason = "EXECUTED";
      this.save(j);
      return;
    }
    // Always reconcile already-signed work before checking eligibility or source expiration.
    const swap = this.db.get<TxRecord>("transaction", o.swapId);
    if (swap) {
      if (!(await this.final(o.swapId, confirmations))) return;
      if (
        this.db.get<TxRecord>("transaction", o.swapId)?.state === "REVERTED"
      ) {
        j.status = "RECONCILING";
        j.reason = "SWAP_REVERTED";
        this.save(j);
        return;
      }
      const fill = await recordV2Fill(
        this.db,
        this.dex.provider,
        o.quoteId!,
        o.swapId,
        confirmations,
      );
      o.fillId = fill.id;
      j.index++;
      this.save(j);
      return;
    }
    const approval = this.db.get<TxRecord>("transaction", o.approvalId);
    if (approval) {
      if (!(await this.final(o.approvalId, confirmations))) return;
      if (
        this.db.get<TxRecord>("transaction", o.approvalId)?.state === "REVERTED"
      ) {
        j.status = "RECONCILING";
        j.reason = "APPROVAL_REVERTED";
        this.save(j);
        return;
      }
    }
    try {
      this.assertCanSign(j.planId);
    } catch {
      j.status = "RECONCILING";
      j.reason = "SOURCE_OR_WORKER_UNAVAILABLE";
      this.save(j);
      return;
    }
    if (!approval) {
      const request = {
        to: o.input,
        data: erc20.encodeFunctionData("approve", [
          this.dex.config.router,
          o.amountIn,
        ]),
        value: 0n,
      };
      const p = this.db.get<Plan>("stable-wallet-plan", j.planId)!;
      this.reservations.bind(
        j.reservationId!,
        o.approvalId,
        request,
        this.options.maxTransactionFeeWei,
        p.validUntil,
        this.clock(),
      );
      await this.preflight(j, o, false);
      this.assertCanSign(j.planId);
      await this.journal.send(
        o.approvalId,
        j.wallet,
        () => this.signer(j.agent),
        request,
      );
      return;
    }
    let quote = o.quoteId
      ? this.db.get<V2Quote>("dex-v2-quote", o.quoteId)
      : undefined;
    if (quote && this.clock() >= quote.validUntil) {
      j.status = "RECONCILING";
      j.reason = "QUOTE_WINDOW_CLOSED";
      this.save(j);
      return;
    }
    if (!quote) {
      quote = await this.dex.quote(j.wallet, o.input, o.output, o.amountIn);
      this.assertCanSign(j.planId);
      const p = this.db.get<Plan>("stable-wallet-plan", j.planId)!,
        s = this.db.get<PortfolioSnapshot>("portfolio-snapshot", p.snapshotId)!;
      const output = s.holdings.find((h) => h.asset === o.output)!,
        asset = this.collector.registry.assets.find(
          (a) => a.asset === o.output,
        )!;
      const minimumValue =
        (BigInt(quote.minimumOut) * BigInt(output.priceMicros)) /
        10n ** BigInt(asset.decimals);
      // DEX pricing must agree with the signed portfolio oracle, not just its own pool reserves.
      if (
        minimumValue * 10000n < BigInt(o.notionalMicros) * 9900n ||
        BigInt(quote.amountOut) * BigInt(output.priceMicros) * 10000n >
          BigInt(o.notionalMicros) * 10100n * 10n ** BigInt(asset.decimals)
      ) {
        j.status = "RECONCILING";
        j.reason = "ORACLE_EXECUTION_DIVERGENCE";
        this.save(j);
        return;
      }
      const native = s.holdings.find((h) => h.asset === "native")!;
      const gasMicros =
        (BigInt(this.options.maxTransactionFeeWei) *
          2n *
          BigInt(native.priceMicros) +
          10n ** 18n -
          1n) /
        10n ** 18n;
      const outputValue =
        (BigInt(quote.amountOut) * BigInt(output.priceMicros) +
          10n ** BigInt(asset.decimals) -
          1n) /
        10n ** BigInt(asset.decimals);
      const riskNotional =
        o.side === "BUY" && outputValue > BigInt(o.notionalMicros)
          ? String(outputValue)
          : o.notionalMicros;
      this.db.transaction(() => {
        new InvestmentRisk(this.db, p.policy).reserve(
          j.cycleId!,
          {
            id: o.swapId,
            side: o.side,
            bucket: o.bucket,
            notionalMicros: riskNotional,
            gasMicros: String(gasMicros),
            slippageBps: this.dex.config.slippageBps,
            priceImpactBps: quote!.impactBps,
            quoteAt: quote!.createdAt,
          },
          this.clock(),
          true,
        );
        o.quoteId = quote!.id;
        this.save(j);
      });
    }
    const request = await this.dex.request(quote.id);
    this.assertCanSign(j.planId);
    const p = this.db.get<Plan>("stable-wallet-plan", j.planId)!;
    this.reservations.bind(
      j.reservationId!,
      o.swapId,
      request,
      this.options.maxTransactionFeeWei,
      Math.min(p.validUntil, quote.validUntil),
      this.clock(),
    );
    await this.preflight(j, o, true);
    this.assertCanSign(j.planId);
    await this.journal.send(
      o.swapId,
      j.wallet,
      () => this.signer(j.agent),
      request,
    );
  }
  private async preflight(
    j: ExecutionJob,
    o: ExecutionOrder,
    allowance: boolean,
  ) {
    const provider = this.dex.provider,
      token = new Contract(o.input, erc20, provider);
    const plan = this.db.get<Plan>("stable-wallet-plan", j.planId)!;
    const snapshot = this.db.get<PortfolioSnapshot>(
      "portfolio-snapshot",
      plan.snapshotId,
    )!;
    const sourceBlock = await provider.send("eth_getBlockByNumber", [
      "0x" + snapshot.blockNumber.toString(16),
      false,
    ]);
    if (sourceBlock?.hash !== snapshot.blockHash)
      throw Error("source snapshot reorged");
    const [balance, permitted, latest, pending, native] = await Promise.all([
      token.balanceOf!(j.wallet),
      allowance
        ? token.allowance!(j.wallet, this.dex.config.router)
        : Promise.resolve(0n),
      provider.getTransactionCount(j.wallet, "latest"),
      provider.getTransactionCount(j.wallet, "pending"),
      provider.getBalance(j.wallet),
    ]);
    if (
      BigInt(balance) < BigInt(o.amountIn) ||
      (allowance && BigInt(permitted) < BigInt(o.amountIn)) ||
      latest !== pending ||
      native <
        BigInt(this.gasReserveWei) + BigInt(this.options.maxTransactionFeeWei)
    )
      throw Error("wallet preflight failed");
  }
  private async reconcile(j: ExecutionJob) {
    const original = this.recoverySettings(j);
    const confirmations = original.registry.confirmations;
    for (const o of j.orders)
      for (const id of [o.approvalId, o.swapId])
        if (
          this.db.get("transaction", id) &&
          !(await this.final(id, confirmations))
        )
          return;
    for (const o of j.orders) {
      if (o.fillId) {
        const fill = await recordV2Fill(
          this.db,
          this.dex.provider,
          o.quoteId!,
          o.swapId,
          confirmations,
        );
        if (fill.id !== o.fillId) {
          o.fillId = fill.id;
          this.save(j);
        }
      }
    }
    let snapshot = j.closingSnapshotId
      ? this.db.get<PortfolioSnapshot>(
          "portfolio-snapshot",
          j.closingSnapshotId,
        )
      : undefined;
    if (!snapshot) {
      const opening = original.opening;
      const collector = new PortfolioCollector(
        this.db,
        new EthersPortfolioReader(this.dex.provider),
        original.registry,
        this.clock,
      );
      snapshot = await collector.collect({
        id: hash(["execution-close/1", j.id, j.attempts]),
        agent: j.agent,
        wallet: j.wallet,
        gasReserveWei: original.gasReserveWei,
        reservationSource: j.reservationId ?? j.id,
        reserved: Object.fromEntries(
          collector.registry.assets.map((a) => [a.asset, "0"]),
        ),
      });
      if (
        snapshot.blockNumber <= opening.blockNumber ||
        snapshot.observedAt <= opening.observedAt
      )
        throw Error("closing boundary has not advanced");
      this.save(j);
      this.db.transaction(() => {
        if (j.reservationId && executionSucceeded(j.reason))
          this.reservations.settle(
            j.reservationId!,
            snapshot!.id,
            this.clock(),
          );
        else if (j.reservationId)
          this.reservations.abort(j.reservationId!, snapshot!.id, this.clock());
        j.closingSnapshotId = snapshot!.id;
        this.save(j);
      });
    }
    const p = this.db.get<Plan>("stable-wallet-plan", j.planId)!;
    const cashflow = await proveExecutionNoExternalFlow(
      this.db,
      this.dex.provider,
      p.snapshotId,
      snapshot.id,
      j.orders
        .flatMap((o) => [o.approvalId, o.swapId])
        .filter((id) => !!this.db.get("transaction", id)),
      confirmations,
    );
    this.save(j);
    const observation = this.feedback.recordWallet({
      roundId: j.roundId,
      chainId: j.chainId,
      agentId: j.agent,
      wallet: j.wallet,
      jobId: j.id,
      planId: j.planId,
      openingSnapshotId: p.snapshotId,
      closingSnapshotId: snapshot.id,
      fillIds: j.orders.flatMap((o) => (o.fillId ? [o.fillId] : [])),
      cashflow,
    });
    j.observationId = observation.id;
    j.status = executionSucceeded(j.reason) ? "DONE" : "ABORTED";
    this.save(j);
  }
  private finishRounds() {
    const jobs = this.db.all<ExecutionJob>("investment-execution-job");
    const allPlanning = this.db.all<{
      epoch: string;
      status: string;
      wallet: string;
    }>("investment-planning-job");
    for (const roundId of new Set([
      ...jobs.map((j) => j.roundId),
      ...allPlanning.map((j) => j.epoch),
    ])) {
      const members = jobs.filter(
        (j) => j.roundId === roundId && j.chainId === this.consumer.chainId,
      );
      const planning = this.db
        .all<{ epoch: string; status: string; wallet: string }>(
          "investment-planning-job",
        )
        .filter((j) => j.epoch === roundId);
      if (
        (!members.length && !planning.length) ||
        members.some((j) => !["DONE", "ABORTED"].includes(j.status)) ||
        planning.some((j) => !["DONE", "FAILED", "EXPIRED"].includes(j.status))
      )
        continue;
      const readyPlans = this.db
        .all<Plan>("stable-wallet-plan")
        .filter(
          (p) =>
            p.chainId === this.consumer.chainId &&
            p.epoch === roundId &&
            ["READY", "NO_ACTION"].includes(p.status),
        );
      if (readyPlans.some((p) => !members.some((j) => j.planId === p.id)))
        continue;
      const id = hash([this.consumer.chainId, roundId]);
      if (this.db.get("investment-execution-round", id)) continue;
      const network = this.feedback.recordNetwork({
        roundId,
        chainId: this.consumer.chainId,
        memberObservationIds: members.flatMap((j) =>
          j.observationId ? [j.observationId] : [],
        ),
        expectedWallets: [
          ...new Set([
            ...members.map((j) => j.wallet),
            ...planning.map((j) => j.wallet),
          ]),
        ],
      });
      this.db.insert("investment-execution-round", id, {
        roundId,
        chainId: this.consumer.chainId,
        status: "COMPLETE",
        finishedAt: this.clock(),
        networkObservationId: network.id,
      });
    }
  }
}
