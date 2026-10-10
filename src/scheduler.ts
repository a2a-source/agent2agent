import { nextRoundAt } from "./cadence.js";
import type { TaxSettlement } from "./tax-settlement.js";
import type { Runner } from "./runner.js";
import type { Watcher } from "./watcher.js";
import type { FlapLauncher } from "./flap.js";
import type { Penalties } from "./penalties.js";
import type { Epoch } from "./epochs.js";
import type { TxRecord } from "./chain.js";
import type { WalletMaintenance } from "./wallet-maintenance.js";
import type { ChainState } from "./watcher.js";
import type { EncryptedWallet } from "./wallet.js";
import { MIN_STAKE } from "./money.js";
export class Scheduler {
  private busy = false;
  private stopped = false;
  private idle?: Promise<void>;
  private resolveIdle?: () => void;
  private runTask?: Promise<void>;
  async stop() {
    this.stopped = true;
    this.runner.cancel();
    await this.idle;
    await this.runTask;
  }
  constructor(
    readonly runner: Runner,
    readonly penalties: Penalties,
    readonly watcher?: Watcher,
    readonly launcher?: FlapLauncher,
    readonly maintenance?: WalletMaintenance,
    readonly settlement?: TaxSettlement,
    readonly accounting?: { tick(): void | Promise<void> },
  ) {}
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.idle = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
    try {
      const db = this.runner.agents.db;
      if (this.accounting) {
        try {
          await this.accounting.tick();
          db.put("service-error", "performance-accounting", {
            status: "HEALTHY",
          });
        } catch {
          db.put("service-error", "performance-accounting", {
            at: Date.now(),
            reason: "ACCOUNTING_RETRY_PENDING",
          });
        }
      }
      if (this.stopped) return;
      if (this.watcher) {
        try {
          await this.watcher.journal.recover(this.watcher.confirmations);
          await this.watcher.tick();
        } catch {
          for (const a of this.runner.agents.list()) {
            const state = db.get<any>("chain-state", a.id);
            if (state) db.put("chain-state", a.id, { ...state, known: false });
          }
          db.put("service-error", "chain", {
            at: Date.now(),
            reason: "CHAIN_SYNC_FAILED",
          });
        }
      }
      if (this.stopped) return;
      for (const a of this.runner.agents.list()) {
        const launch = db.get<TxRecord>("transaction", `launch:${a.id}`);
        if (a.launch === "CONFIRMED" && launch && launch.state !== "CONFIRMED")
          this.runner.agents.update(a.id, { launch: "PENDING" });
      }
      if (this.launcher && this.launcher.journal.enabled)
        for (const a of this.runner.agents
          .list()
          .filter((a) => a.launch === "PENDING")) {
          try {
            await this.launcher.advance(a.id);
          } catch {
            db.put("service-error", `launch:${a.id}`, {
              at: Date.now(),
              reason: "LAUNCH_PENDING_RETRY",
            });
          }
        }
      if (this.stopped) return;
      if (this.settlement) {
        try {
          await this.settlement.tick();
        } catch {
          db.put("service-error", "settlement", {
            at: Date.now(),
            reason: "SETTLEMENT_RETRY_PENDING",
          });
        }
      }
      if (this.stopped) return;
      if (this.maintenance) {
        try {
          await this.maintenance.tick();
          db.put("service-error", "wallet-maintenance", { status: "HEALTHY" });
        } catch {
          db.put("service-error", "wallet-maintenance", {
            at: Date.now(),
            reason: "MAINTENANCE_RETRY_PENDING",
          });
        }
      }
      if (this.stopped) return;
      this.penalties.observeResearch();
      const confirming = db
        .all<Epoch>("epoch")
        .some(
          (e) =>
            e.status === "RUNNING" && !!db.get("confirmation-proposal", e.id),
        );
      let priceReady = false;
      let providerReady = false;
      if (!confirming) {
        try {
          await this.runner.llm.refreshPrice();
          priceReady = this.runner.llm.priceReady();
        } catch {}
        db.put(
          "service-error",
          "price-oracle",
          priceReady
            ? { status: "HEALTHY" }
            : { at: Date.now(), reason: "PRICE_RETRY_PENDING" },
        );
        providerReady = priceReady && (await this.runner.llm.probeProvider());
        if (this.stopped) return;
        await this.penalties.recoverOperational(async (id) => {
          const a = this.runner.agents.get(id),
            state = db.get<ChainState>("chain-state", id);
          if (
            !providerReady ||
            a.launch !== "CONFIRMED" ||
            !state?.known ||
            Date.now() - state.observedAt >
              this.runner.config.network.stateMaxAgeMs ||
            BigInt(state.bonded) < MIN_STAKE ||
            BigInt(state.exit) > 0n ||
            this.runner.budget.available(id) < this.runner.llm.maximum()
          )
            return false;
          const wallet = db.get<EncryptedWallet>("wallet", id);
          if (!wallet) return false;
          await this.runner.agents.vault.verify(wallet);
          return true;
        });
        if (this.stopped) return;
      }
      const now = Date.now();
      let e = db.all<Epoch>("epoch").find((e) => e.status === "RUNNING");
      if (e && now >= e.deadline) {
        this.runner.cancel();
        this.runner.epochs.incident(
          `timeout:${e.id}:${e.view}`,
          e.master,
          confirming ? "CONFIRMATION_TIMEOUT" : "ROUND_TIMEOUT",
          now,
        );
        e = this.runner.epochs.takeover(e.id, e.view, now);
      }
      if (e?.status === "FAILED" || (!providerReady && !confirming)) return;
      if (!e) {
        const last = db.all<Epoch>("epoch").sort((a, b) => b.slot - a.slot)[0];
        if (now < nextRoundAt(db, now, this.runner.config.network.epochMs))
          return;
        const candidates = this.runner.candidates(now);
        if (candidates.length < 3) return;
        e = this.runner.epochs.open(
          (last?.slot ?? -1) + 1,
          candidates,
          this.runner.config.network,
          now,
        );
      }
      if (
        this.runTask ||
        (!db.get("confirmation-proposal", e.id) &&
          db.get("incident", `${e.id}:${e.view}:failure`))
      )
        return;
      this.runTask = this.runner
        .run(e)
        .then(() => {
          db.put("service-error", "runner", { status: "HEALTHY" });
        })
        .catch(() => {
          db.put("service-error", "runner", {
            at: Date.now(),
            reason: db.get("confirmation-proposal", e!.id)
              ? "CONFIRMATION_RETRY_PENDING"
              : "ROUND_FAILED_WAITING_FOR_TAKEOVER",
          });
        })
        .finally(async () => {
          try {
            await this.accounting?.tick();
          } catch {
            db.put("service-error", "performance-accounting", {
              at: Date.now(),
              reason: "ACCOUNTING_RETRY_PENDING",
            });
          } finally {
            this.runTask = undefined;
          }
        });
    } finally {
      this.busy = false;
      this.resolveIdle?.();
      this.idle = undefined;
    }
  }
}
