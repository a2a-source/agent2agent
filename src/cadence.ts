import type { Epoch } from "./epochs.js";
import { Store } from "./store.js";
export const DEFAULT_ROUND_INTERVAL_MS = 300000;
export function validInterval(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw Error("invalid round interval");
  return value;
}
function after(at: number, interval: number) {
  const result = at + validInterval(interval);
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(result))
    throw Error("invalid round timestamp");
  return result;
}
export function terminalTiming(epoch: Epoch, now: number) {
  const roundIntervalMs = epoch.roundIntervalMs ?? DEFAULT_ROUND_INTERVAL_MS;
  return {
    roundIntervalMs,
    finishedAt: now,
    nextEligibleAt: after(now, roundIntervalMs),
  };
}
/** Unknown historical finish times use a durable first-observed time, never an invented completion time. */
export function nextRoundAt(db: Store, now: number, interval: number): number {
  return db.transaction(() => {
    const last = db.all<Epoch>("epoch").sort((a, b) => b.slot - a.slot)[0];
    if (!last) return 0;
    if (last.status === "RUNNING") return Infinity;
    if (last.nextEligibleAt !== undefined) {
      if (
        last.finishedAt === undefined ||
        last.roundIntervalMs === undefined ||
        last.nextEligibleAt !== after(last.finishedAt, last.roundIntervalMs)
      )
        throw Error("invalid terminal timing");
      return last.nextEligibleAt;
    }
    const saved = db.get<{
      version?: string;
      afterEpoch?: string;
      observedTerminalAt: number;
      intervalMs: number;
      nextAt: number;
    }>("schedule", "network");
    if (saved?.version === "end-relative/1" && saved.afterEpoch === last.id) {
      if (saved.nextAt !== after(saved.observedTerminalAt, saved.intervalMs))
        throw Error("invalid historical terminal timing");
      return saved.nextAt;
    }
    const nextAt = after(now, interval);
    db.put("schedule", "network", {
      version: "end-relative/1",
      afterEpoch: last.id,
      observedTerminalAt: now,
      intervalMs: interval,
      nextAt,
    });
    return nextAt;
  });
}
