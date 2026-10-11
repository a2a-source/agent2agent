import type { Epoch } from "./epochs.js";
import { Store } from "./store.js";
export interface RoundTiming {
  version: "fixed-start/1";
  intervalMs: number;
  maxDurationMs: number;
  viewTimeoutMs: number;
  confirmationReserveMs: number;
}
export function validateRoundTiming(t: RoundTiming) {
  for (const value of [
    t.intervalMs,
    t.maxDurationMs,
    t.viewTimeoutMs,
    t.confirmationReserveMs,
  ])
    validInterval(value);
  if (
    t.version !== "fixed-start/1" ||
    t.maxDurationMs > t.intervalMs ||
    t.viewTimeoutMs > t.maxDurationMs ||
    t.confirmationReserveMs >= t.maxDurationMs
  )
    throw Error("invalid round timing");
  return t;
}
/** Legacy records omit timing entirely; new records must retain every frozen bound. */
export function validateEpochTiming(e: Epoch) {
  if (!e.timingVersion && !e.roundTiming) return;
  const t = e.roundTiming;
  if (!t) throw Error("invalid round timing");
  validateRoundTiming(t);
  if (
    e.timingVersion !== t.version ||
    !Number.isSafeInteger(e.deadline) ||
    !Number.isSafeInteger(e.researchDeadline) ||
    !Number.isSafeInteger(e.scheduledAt) ||
    e.scheduledAt! < 0 ||
    !Number.isSafeInteger(e.startedAt) ||
    e.startedAt! < e.scheduledAt! ||
    e.startedAt! >= e.researchDeadline! ||
    e.roundIntervalMs !== t.intervalMs ||
    !Number.isSafeInteger(e.roundDeadline) ||
    e.roundDeadline !== e.scheduledAt! + t.maxDurationMs ||
    e.researchDeadline !== e.roundDeadline! - t.confirmationReserveMs ||
    e.deadline > (e.confirmationDeadline ?? e.researchDeadline!) ||
    (e.confirmationDeadline !== undefined &&
      e.confirmationDeadline > e.roundDeadline!)
  )
    throw Error("invalid round timing");
}
export interface FixedSchedule {
  version: "fixed-start/1";
  anchorAt: number;
  intervalMs: number;
  lastScheduledAt?: number;
  lastEpoch?: string;
  skippedSlots: number;
}
/** Claim only the current grid slot. The caller opens the epoch in this transaction. */
export function claimFixedSlot(
  db: Store,
  timing: RoundTiming,
  now: number,
  admit: (scheduledAt: number) => string | undefined,
) {
  return db.transaction(() => {
    validateRoundTiming(timing);
    const saved = db.get<FixedSchedule>("schedule", "fixed-start/1") ?? {
      version: "fixed-start/1" as const,
      anchorAt: now,
      intervalMs: timing.intervalMs,
      skippedSlots: 0,
    };
    if (saved.intervalMs !== timing.intervalMs)
      throw Error("fixed schedule interval changed");
    const scheduledAt =
      saved.anchorAt +
      Math.floor((now - saved.anchorAt) / saved.intervalMs) * saved.intervalMs;
    if (
      scheduledAt < saved.anchorAt ||
      scheduledAt <= (saved.lastScheduledAt ?? -1)
    )
      return;
    const missed = Math.max(
      0,
      Math.round(
        (scheduledAt -
          (saved.lastScheduledAt ?? saved.anchorAt - saved.intervalMs)) /
          saved.intervalMs,
      ) - 1,
    );
    const epoch =
      now < scheduledAt + timing.maxDurationMs - timing.confirmationReserveMs
        ? admit(scheduledAt)
        : undefined;
    db.put("schedule", "fixed-start/1", {
      ...saved,
      lastScheduledAt: scheduledAt,
      ...(epoch ? { lastEpoch: epoch } : {}),
      skippedSlots: saved.skippedSlots + missed + (epoch ? 0 : 1),
    });
    if (!epoch || missed)
      db.put("schedule-skip", String(scheduledAt), {
        scheduledAt,
        at: now,
        missedSlots: missed + (epoch ? 0 : 1),
        reason: epoch ? "MISSED_SLOTS" : "SLOT_UNAVAILABLE",
      });
    return epoch;
  });
}
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
    nextEligibleAt: after(
      epoch.timingVersion ? epoch.scheduledAt! : now,
      roundIntervalMs,
    ),
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
