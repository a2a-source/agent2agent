import { nextRoundAt, claimFixedSlot } from "./cadence.js";
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
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private deadlineKey?: string;
  private housekeepingTask?: Promise<void>;
  private readinessTask?: Promise<void>;
  private readiness?: { at: number; ready: boolean };
  private busy = false;
  private stopped = false;
  private idle?: Promise<void>;
  private resolveIdle?: () => void;
  private runTask?: Promise<void>;
  private planningTask?: Promise<void>;
  private executionTask?: Promise<void>;
  private accountingTask?: Promise<void>;
  async stop() {
    this.stopped = true;
    this.clearDeadline();
    this.runner.cancel();
    await this.idle;
    await this.housekeepingTask;
    await this.readinessTask;
    await this.runTask;
    await this.planningTask;
    await this.executionTask;
    await this.accountingTask;
  }
  constructor(
    readonly runner: Runner,
    readonly penalties: Penalties,
    readonly watcher?: Watcher,
    readonly launcher?: FlapLauncher,
    readonly maintenance?: WalletMaintenance,
    readonly settlement?: TaxSettlement,
    readonly accounting?: { tick(): void | Promise<void> },
    readonly planning?: { tick(): Promise<void> },
    readonly execution?: { tick(): Promise<void> },
  ) {}
  async tick() {
    if (this.runner.config?.roundTiming) {
      if (this.stopped) return;
      this.startAccounting();
      if (!this.housekeepingTask)
        this.housekeepingTask = this.housekeeping()
          .catch(() => {
            this.runner.agents.db.put("service-error", "housekeeping", {
              at: Date.now(),
              reason: "HOUSEKEEPING_RETRY_PENDING",
            });
          })
          .finally(() => {
            this.housekeepingTask = undefined;
          });
      if (!this.readinessTask)
        this.readinessTask = this.refreshReadiness()
          .catch(() => {
            this.readiness = { at: Date.now(), ready: false };
          })
          .finally(() => {
            this.readinessTask = undefined;
            if (!this.stopped) {
              try {
                this.controlRound();
              } catch {
                this.runner.agents.db.put("service-error", "round-control", {
                  at: Date.now(),
                  reason: "ROUND_CONTROL_FAILED",
                });
              }
            }
          });
      this.controlRound();
      return;
    }
    await this.legacyTick();
  }
  private async housekeeping() {
    const db = this.runner.agents.db;
    if (this.stopped) return;
    if (this.watcher) {
      try {
        await this.watcher.journal.recover(this.watcher.confirmations);
        if (this.stopped) return;
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
          if (this.stopped) return;
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
    if (this.planning && !this.planningTask) {
      this.planningTask = Promise.resolve()
        .then(() => (this.stopped ? undefined : this.planning!.tick()))
        .then(() => {
          db.put("service-error", "investment-planning", {
            status: "HEALTHY",
          });
        })
        .catch(() => {
          db.put("service-error", "investment-planning", {
            at: Date.now(),
            reason: "PLANNING_RETRY_PENDING",
          });
        })
        .finally(() => {
          this.planningTask = undefined;
        });
    }
    if (this.execution && !this.executionTask) {
      this.executionTask = Promise.resolve()
        .then(() => (this.stopped ? undefined : this.execution!.tick()))
        .then(() => {
          db.put("service-error", "investment-execution", {
            status: "HEALTHY",
          });
        })
        .catch(() => {
          db.put("service-error", "investment-execution", {
            at: Date.now(),
            reason: "EXECUTION_RETRY_PENDING",
          });
        })
        .finally(() => {
          this.executionTask = undefined;
        });
    }
  }
  private async refreshReadiness() {
    let ready = false;
    try {
      await this.runner.llm.refreshPrice();
      if (this.stopped) return;
      ready =
        this.runner.llm.priceReady() && (await this.runner.llm.probeProvider());
      if (this.stopped) return;
      await this.penalties.recoverOperational(async (id) => {
        if (this.stopped || !ready) return false;
        const a = this.runner.agents.get(id),
          state = this.runner.agents.db.get<ChainState>("chain-state", id);
        if (
          a.launch !== "CONFIRMED" ||
          !state?.known ||
          Date.now() - state.observedAt >
            this.runner.config.network.stateMaxAgeMs ||
          BigInt(state.bonded) < MIN_STAKE ||
          BigInt(state.exit) > 0n ||
          this.runner.budget.available(id) < this.runner.llm.maximum()
        )
          return false;
        const wallet = this.runner.agents.db.get<EncryptedWallet>("wallet", id);
        if (!wallet) return false;
        await this.runner.agents.vault.verify(wallet);
        return !this.stopped;
      });
    } finally {
      if (!this.stopped) {
        this.readiness = { at: Date.now(), ready };
        this.runner.agents.db.put("service-error", "research-readiness", {
          at: Date.now(),
          status: ready ? "HEALTHY" : "UNAVAILABLE",
        });
      }
    }
  }
  private clearDeadline() {
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    this.deadlineKey = undefined;
  }
  /** Epoch lifetime outlives each settled research/confirmation attempt. */
  private armDeadline() {
    if (this.stopped || !this.runner.config?.roundTiming) {
      this.clearDeadline();
      return;
    }
    const row = this.runner.agents.db
      .all<Epoch>("epoch")
      .find((e) => e.status === "RUNNING");
    if (!row) {
      this.clearDeadline();
      return;
    }
    const epoch = this.runner.epochs.get(row.id);
    const deadline = Math.min(
      epoch.deadline,
      epoch.roundDeadline ?? Infinity,
      epoch.confirmationDeadline ?? Infinity,
    );
    const key = `${epoch.id}:${epoch.view}:${deadline}`;
    if (key === this.deadlineKey) return;
    this.clearDeadline();
    this.deadlineKey = key;
    this.deadlineTimer = setTimeout(
      () => {
        if (this.stopped || this.deadlineKey !== key) return;
        this.deadlineTimer = undefined;
        this.deadlineKey = undefined;
        try {
          this.controlRound();
        } catch {
          this.runner.agents.db.put("service-error", "round-control", {
            at: Date.now(),
            reason: "ROUND_CONTROL_FAILED",
          });
        }
      },
      Math.max(0, deadline - Date.now()),
    );
    this.deadlineTimer.unref();
  }
  private controlRound() {
    if (this.stopped) return;
    try {
      this.advanceRound();
    } finally {
      this.armDeadline();
    }
  }
  private advanceRound() {
    if (this.stopped) return;
    const db = this.runner.agents.db,
      now = Date.now(),
      timing = this.runner.config.roundTiming!;
    if (!db.get("schedule", "fixed-start/1"))
      db.put("schedule", "fixed-start/1", {
        version: timing.version,
        anchorAt: now,
        intervalMs: timing.intervalMs,
        skippedSlots: 0,
      });
    let e = db.all<Epoch>("epoch").find((e) => e.status === "RUNNING");
    if (e) e = this.runner.epochs.get(e.id);
    if (e && !e.timingVersion) {
      this.runner.cancel();
      this.runner.epochs.fail(e.id, e.view, "TIMING_MIGRATION_REQUIRED", now);
      e = undefined;
    }
    if (e) {
      const confirming = !!db.get("confirmation-proposal", e.id);
      if (now >= e.deadline || now >= e.roundDeadline!) {
        this.runner.cancel();
        this.runner.epochs.incident(
          `timeout:${e.id}:${e.view}`,
          e.master,
          confirming ? "CONFIRMATION_TIMEOUT" : "ROUND_TIMEOUT",
          now,
        );
        e = this.runner.epochs.takeover(e.id, e.view, now);
      } else if (!confirming && this.runner.epochs.failedView(e.id, e.view)) {
        this.runner.cancel();
        e = this.runner.epochs.recoverFailedView(e.id, e.view, now);
      }
      if (e.status !== "RUNNING") e = undefined;
    }
    if (!e) {
      // A stalled readiness operation cannot extend the slot. Leave an eligible
      // slot open while its first probe is pending, then record its expiry.
      const schedule = db.get<{ anchorAt: number }>(
        "schedule",
        "fixed-start/1",
      )!;
      const scheduledAt =
        schedule.anchorAt +
        Math.floor((now - schedule.anchorAt) / timing.intervalMs) *
          timing.intervalMs;
      if (
        (!this.readiness ||
          now - this.readiness.at > this.runner.config.network.stateMaxAgeMs) &&
        now < scheduledAt + timing.maxDurationMs - timing.confirmationReserveMs
      )
        return;
      const id = claimFixedSlot(db, timing, now, (scheduled) => {
        if (
          this.runTask ||
          !this.readiness?.ready ||
          now - this.readiness.at > this.runner.config.network.stateMaxAgeMs ||
          !this.runner.llm.priceReady()
        )
          return;
        const candidates = this.runner.candidates(now);
        if (candidates.length < 3) return;
        const last = db.all<Epoch>("epoch").sort((a, b) => b.slot - a.slot)[0];
        return this.runner.epochs.open(
          (last?.slot ?? -1) + 1,
          candidates,
          this.runner.config.network,
          now,
          timing,
          scheduled,
        ).id;
      });
      if (id) e = this.runner.epochs.get(id);
    }
    if (!e || this.runTask) return;
    const epoch = e;
    this.runTask = this.runner
      .run(epoch)
      .then(() => {})
      .catch(() => {
        db.put("service-error", "runner", {
          at: Date.now(),
          reason: "ROUND_RECOVERY_PENDING",
        });
      })
      .finally(() => {
        this.runTask = undefined;
        this.startAccounting();
        this.armDeadline();
      });
  }
  private async legacyTick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.idle = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
    try {
      const db = this.runner.agents.db;
      this.startAccounting();
      if (this.stopped) return;
      await this.housekeeping();
      if (this.stopped) return;
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
              : db.get<Epoch>("epoch", e!.id)?.status === "FAILED"
                ? "ROUND_TERMINATED_WAITING_FOR_CADENCE"
                : "ROUND_FAILED_WAITING_FOR_TAKEOVER",
          });
        })
        .finally(() => {
          this.startAccounting();
          this.runTask = undefined;
        });
    } finally {
      this.busy = false;
      this.resolveIdle?.();
      this.idle = undefined;
    }
  }
  private startAccounting() {
    if (!this.accounting || this.accountingTask || this.stopped) return;
    const db = this.runner.agents.db;
    this.accountingTask = Promise.resolve()
      .then(() => (this.stopped ? undefined : this.accounting!.tick()))
      .then(() => {
        db.put("service-error", "performance-accounting", {
          status: "HEALTHY",
        });
      })
      .catch(() => {
        db.put("service-error", "performance-accounting", {
          at: Date.now(),
          reason: "ACCOUNTING_RETRY_PENDING",
        });
      })
      .finally(() => {
        this.accountingTask = undefined;
      });
  }
}
