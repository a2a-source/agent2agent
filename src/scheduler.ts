import type { Runner } from "./runner.js";
import type { Watcher } from "./watcher.js";
import type { FlapLauncher } from "./flap.js";
import type { Penalties } from "./penalties.js";
import type { Epoch } from "./epochs.js";
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
  ) {}
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.idle = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
    try {
      const db = this.runner.agents.db;
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
      const now = Date.now();
      let e = db.all<Epoch>("epoch").find((e) => e.status === "RUNNING");
      if (e && now >= e.deadline) {
        this.runner.cancel();
        this.penalties.failure(`timeout:${e.id}:${e.view}`, e.master, now);
        e = this.runner.epochs.takeover(e.id, e.view, now);
      }
      if (e?.status === "FAILED") return;
      if (!e) {
        const last = db.all<Epoch>("epoch").sort((a, b) => b.slot - a.slot)[0];
        const schedule = db.get<{ nextAt: number }>("schedule", "network");
        if (schedule && now < schedule.nextAt) return;
        const candidates = this.runner.candidates(now);
        if (candidates.length < 3) return;
        e = this.runner.epochs.open(
          (last?.slot ?? -1) + 1,
          candidates,
          this.runner.config.network,
          now,
        );
        db.put("schedule", "network", {
          nextAt: now + this.runner.config.network.epochMs,
        });
      }
      if (this.runTask || db.get("incident", `${e.id}:${e.view}:failure`))
        return;
      this.runTask = this.runner
        .run(e)
        .then(() => {})
        .catch(() => {
          db.put("service-error", "runner", {
            at: Date.now(),
            reason: "ROUND_FAILED_WAITING_FOR_TAKEOVER",
          });
        })
        .finally(() => {
          this.runTask = undefined;
        });
    } finally {
      this.busy = false;
      this.resolveIdle?.();
      this.idle = undefined;
    }
  }
}
