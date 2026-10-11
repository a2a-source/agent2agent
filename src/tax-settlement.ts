import {
  Contract,
  Transaction,
  ZeroAddress,
  keccak256,
  toUtf8Bytes,
  type Wallet,
  type HDNodeWallet,
} from "ethers";
import { Agents, type Agent } from "./agents.js";
import { Journal, type TxRecord } from "./chain.js";
import { FACTORY_ABI } from "./flap.js";

export interface SettlementConfig {
  factory: string;
  confirmations: number;
  minRevenueWei: string;
  maxFeeWei: string;
  dailyBudgetWei: string;
  gasReserveWei: string;
  intervalMs: number;
}
interface Operation {
  sequence: number;
  nextAt: number;
  id?: string;
  target?: string;
  action?: "dispatch" | "flush";
  maxFeeWei?: string;
  before?: string;
  lastAction?: "dispatch" | "flush";
  flushUntil?: number;
  dispatchUntil?: number;
  flushFailures?: number;
  dispatchFailures?: number;
}
/** Permissionless revenue delivery; only confirmed PlatformPaid events create compute credit. */
export class TaxSettlement {
  readonly journal: Journal;
  constructor(
    readonly agents: Agents,
    journal: Journal,
    readonly signer: Wallet | HDNodeWallet,
    readonly config: SettlementConfig,
  ) {
    this.journal = new Journal(
      agents.db,
      journal.provider,
      journal.chainId,
      journal.enabled,
      {
        ...journal.policy,
        maxTransactionFeeWei: config.maxFeeWei,
        maxLogicalAttempts: 0,
      },
    );
  }
  private async inspect(a: Agent, blockTag: number | "latest") {
    const p = this.journal.provider,
      opt = { blockTag };
    if (!a.token || !a.splitter) throw Error("missing launch binding");
    const factory = new Contract(this.config.factory, FACTORY_ABI, p);
    const split = new Contract(
      a.splitter,
      [
        "function agent() view returns(address)",
        "function platform() view returns(address)",
        "function platformPending() view returns(uint256)",
        "function agentPending() view returns(uint256)",
      ],
      p,
    );
    const token = new Contract(
      a.token,
      ["function taxProcessor() view returns(address)"],
      p,
    );
    const [predicted, platform, recipient, splitPlatform, processorAddress] =
      await Promise.all([
        factory.getFunction("predict")(
          keccak256(toUtf8Bytes(a.id)),
          a.wallet,
          opt,
        ),
        factory.getFunction("platform")(opt),
        split.getFunction("agent")(opt),
        split.getFunction("platform")(opt),
        token.getFunction("taxProcessor")(opt),
      ]);
    const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
    if (
      !same(predicted, a.splitter) ||
      !same(recipient, a.wallet) ||
      !same(platform, splitPlatform)
    )
      throw Error("splitter binding changed");
    const processor = new Contract(
      processorAddress,
      [
        "function taxToken() view returns(address)",
        "function marketAddress() view returns(address)",
        "function getQuoteToken() view returns(address)",
        "function weth() view returns(address)",
        "function marketQuoteBalance() view returns(uint256)",
      ],
      p,
    );
    const [
      taxToken,
      market,
      quote,
      weth,
      marketPending,
      platformPending,
      agentPending,
    ] = await Promise.all([
      processor.getFunction("taxToken")(opt),
      processor.getFunction("marketAddress")(opt),
      processor.getFunction("getQuoteToken")(opt),
      processor.getFunction("weth")(opt),
      processor.getFunction("marketQuoteBalance")(opt),
      split.getFunction("platformPending")(opt),
      split.getFunction("agentPending")(opt),
    ]);
    if (
      !same(taxToken, a.token) ||
      !same(market, a.splitter) ||
      (!same(quote, ZeroAddress) && !same(quote, weth))
    )
      throw Error("processor binding or quote changed");
    return {
      processor: processorAddress as string,
      dispatch: BigInt(marketPending),
      flush: BigInt(platformPending) + BigInt(agentPending),
    };
  }
  async tick(now = Date.now()) {
    if (!this.journal.enabled) return;
    const p = this.journal.provider,
      db = this.agents.db,
      c = this.config;
    if ((await p.getNetwork()).chainId !== BigInt(this.journal.chainId))
      throw Error("wrong chain");
    const height = (await p.getBlockNumber()) - c.confirmations + 1;
    if (height < 0) return;
    const block = await p.getBlock(height);
    if (!block?.hash) throw Error("missing confirmed block");
    for (const a of this.agents
      .list()
      .filter((a) => a.launch === "CONFIRMED")) {
      let op = db.get<Operation>("tax-settlement", a.id) ?? {
        sequence: 0,
        nextAt: 0,
      };
      if (now < op.nextAt) continue;
      try {
        const launch = db.get<TxRecord>("transaction", `launch:${a.id}`);
        if (
          !launch ||
          !(await this.journal.confirmed(launch.id, c.confirmations)) ||
          (db.get<TxRecord>("transaction", launch.id)?.block ?? Infinity) >
            height
        )
          throw Error("launch not confirmed");
        const state = await this.inspect(a, height);
        if (op.id) {
          const row = db.get<TxRecord>("transaction", op.id);
          if (row?.state === "REVERTED") {
            // A confirmed revert has no business effect. Recover only after a
            // fresh successful simulation and a sender with no pending nonce.
            const receipt = await p.getTransactionReceipt(row.hash);
            if (
              receipt?.status === 0 &&
              (await receipt.confirmations()) >= c.confirmations &&
              (await p.getBlock(receipt.blockNumber))?.hash ===
                receipt.blockHash
            ) {
              const [latest, pending] = await Promise.all([
                p.getTransactionCount(this.signer.address, "latest"),
                p.getTransactionCount(this.signer.address, "pending"),
              ]);
              if (
                latest === pending &&
                latest > Transaction.from(row.raw).nonce &&
                !db
                  .all<TxRecord>("transaction")
                  .some(
                    (t) =>
                      t.state === "READY" &&
                      t.sender.toLowerCase() ===
                        this.signer.address.toLowerCase(),
                  )
              ) {
                const live = await this.inspect(a, "latest");
                if (
                  op.target !==
                  (op.action === "flush" ? a.splitter : live.processor)
                )
                  throw Error("target changed");
                const call = new Contract(
                  op.target!,
                  ["function dispatch()", "function flush()"],
                  p,
                );
                await p.call({
                  from: this.signer.address,
                  to: op.target,
                  data: call.interface.encodeFunctionData(op.action!),
                });
                db.put("settlement-retired", op.id, {
                  hash: row.hash,
                  at: now,
                  reason: "CANONICAL_REVERT_RECOVERED",
                });
                const action = op.action!,
                  failures = (op[`${action}Failures`] ?? 0) + 1;
                op = {
                  sequence: op.sequence + 1,
                  nextAt: now + c.intervalMs * 2 ** Math.min(failures, 10),
                  lastAction: action,
                  flushFailures: op.flushFailures,
                  dispatchFailures: op.dispatchFailures,
                  [`${action}Failures`]: failures,
                };
                db.put("tax-settlement", a.id, op);
              }
            }
            continue;
          }
          if (row && (await this.journal.confirmed(op.id, c.confirmations))) {
            if (
              (db.get<TxRecord>("transaction", op.id)?.block ?? Infinity) >
              height
            )
              continue;
            const action = op.action!,
              failed = state[action] >= BigInt(op.before ?? "0");
            const failures = failed ? (op[`${action}Failures`] ?? 0) + 1 : 0;
            op = {
              sequence: op.sequence + 1,
              nextAt: now + c.intervalMs,
              lastAction: action,
              flushUntil: op.flushUntil,
              dispatchUntil: op.dispatchUntil,
              flushFailures: op.flushFailures,
              dispatchFailures: op.dispatchFailures,
              [`${action}Failures`]: failures,
              [`${action}Until`]: failed
                ? now + c.intervalMs * 2 ** Math.min(failures, 10)
                : 0,
            };
            db.put("tax-settlement", a.id, op);
            continue;
          }
        } else {
          const canFlush =
            state.flush > 0n &&
            state.flush >= BigInt(c.minRevenueWei) &&
            now >= (op.flushUntil ?? 0);
          const canDispatch =
            state.dispatch > 0n &&
            state.dispatch >= BigInt(c.minRevenueWei) &&
            now >= (op.dispatchUntil ?? 0);
          const action =
            canDispatch && (!canFlush || op.lastAction === "flush")
              ? "dispatch"
              : canFlush
                ? "flush"
                : undefined;
          if (!action) continue;
          op = {
            ...op,
            id: `tax:${a.id}:${op.sequence}`,
            target: action === "flush" ? a.splitter : state.processor,
            action,
            maxFeeWei: c.maxFeeWei,
            before: String(state[action]),
          };
          db.put("tax-settlement", a.id, op);
        }
        if ((await p.getBlock(height))?.hash !== block.hash)
          throw Error("snapshot changed");
        const live = await this.inspect(a, "latest");
        if (op.target !== (op.action === "flush" ? a.splitter : live.processor))
          throw Error("settlement target changed");
        if (live[op.action!] === 0n && !db.get("transaction", op.id!)) {
          db.put("tax-settlement", a.id, {
            sequence: op.sequence + 1,
            nextAt: now + c.intervalMs,
          });
          continue;
        }
        const contract = new Contract(
          op.target!,
          ["function dispatch()", "function flush()"],
          p,
        );
        const row = db.get<TxRecord>("transaction", op.id!);
        const cap =
          BigInt(op.maxFeeWei ?? row?.maxFeeWei ?? c.maxFeeWei) <
          BigInt(c.maxFeeWei)
            ? BigInt(op.maxFeeWei ?? row?.maxFeeWei ?? c.maxFeeWei)
            : BigInt(c.maxFeeWei);
        if (
          (await p.getBalance(this.signer.address)) <
          BigInt(c.gasReserveWei) +
            this.journal.reserved(this.signer.address) +
            (row ? 0n : cap)
        )
          continue;
        if (!row) {
          const day = Math.floor(now / 86400000).toString();
          db.transaction(() => {
            const auth = db.get<{ day: string; cap: string }>(
              "settlement-authorization",
              op.id!,
            );
            const current = BigInt(
              db.get<{ reserved: string }>("settlement-gas", day)?.reserved ??
                "0",
            );
            if (current > BigInt(c.dailyBudgetWei))
              throw Error("daily gas budget");
            if (auth?.day === day && BigInt(auth.cap) >= cap) return;
            if (current + cap > BigInt(c.dailyBudgetWei))
              throw Error("daily gas budget");
            db.put("settlement-gas", day, { reserved: String(current + cap) });
            db.put("settlement-authorization", op.id!, {
              day,
              cap: String(cap),
            });
          });
        }
        // Keep the shared journal recovery policy, while pinning this operation's original ceiling.
        const oldCap = this.journal.policy.maxTransactionFeeWei;
        this.journal.policy.maxTransactionFeeWei = String(cap);
        try {
          await this.journal.send(
            op.id!,
            this.signer.address,
            () => this.signer,
            {
              to: op.target,
              data: contract.interface.encodeFunctionData(op.action!),
            },
            {
              confirmations: c.confirmations,
              safeRetry: async () => {
                const checked = await this.inspect(a, "latest");
                return checked[op.action!] > 0n;
              },
            },
          );
        } finally {
          this.journal.policy.maxTransactionFeeWei = oldCap;
        }
        op.nextAt = now + c.intervalMs;
        db.put("tax-settlement", a.id, op);
        db.put("service-error", `settlement:${a.id}`, {
          status: "PENDING_OR_HEALTHY",
        });
      } catch {
        op.nextAt = now + c.intervalMs;
        db.put("tax-settlement", a.id, op);
        db.put("service-error", `settlement:${a.id}`, {
          at: now,
          reason: "SETTLEMENT_RETRY_PENDING",
        });
      }
    }
  }
}
