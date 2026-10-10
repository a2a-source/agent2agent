import { Store } from "./store.js";
import type { Epoch } from "./epochs.js";
export interface ResearchTask {
  id: string;
  version: 1;
  epoch?: string;
  view?: number;
  contextHash: string;
  workers: string[];
  maxAttempts: number;
  deadline: number;
  status: "ACTIVE" | "DONE" | "FAILED";
  startedAt: number;
  finishedAt?: number;
  terminalReason?: string;
  resultAttemptId?: string;
  legacy?: true;
}
export interface ResearchAttempt {
  id: string;
  taskId?: string;
  attempt?: number;
  agent: string;
  status: "RUNNING" | "DONE" | "FAILED";
  contextHash?: string;
  startedAt?: number;
  finishedAt?: number;
  failure?: string;
  result?: unknown;
}
export function history(db: Store, kind: string, id: string) {
  return db.sql
    .prepare(
      "SELECT operation,data,recorded_at FROM record_history WHERE kind=? AND id=? ORDER BY sequence",
    )
    .all(kind, id)
    .map((r) => ({
      operation: String(r.operation),
      data: JSON.parse(String(r.data)),
      at: Date.parse(String(r.recorded_at)),
    }));
}
function ownership(db: Store, key: string) {
  const match =
    /^(0|[1-9]\d*):(0|[1-9]\d*):(plan|synthesis|report:[^:]+)$/.exec(key);
  if (!match) return;
  const epoch = db.get<Epoch>("epoch", match[1]!);
  const view = Number(match[2]);
  if (!epoch || epoch.id !== match[1] || view > epoch.view) return;
  return { epoch: epoch.id, view };
}
export function closure(
  db: Store,
  owner: { epoch?: string; view?: number; deadline?: number },
  now: number,
) {
  const e =
    owner.epoch === undefined ? undefined : db.get<Epoch>("epoch", owner.epoch);
  const marker =
    owner.epoch === undefined
      ? undefined
      : (db.get<any>("incident", `${owner.epoch}:${owner.view}:failure`) ??
        db.get<any>("research-failure", `${owner.epoch}:${owner.view}`));
  if (marker)
    return { reason: "ROUND_FAILED", at: marker.at as number | undefined };
  if (
    e &&
    owner.view !== undefined &&
    (e.view > owner.view || e.status !== "RUNNING")
  ) {
    const transition = history(db, "epoch", e.id).find(
      (r) =>
        r.operation !== "BASELINE" &&
        (r.data.view > owner.view! ||
          (r.data.view === owner.view && r.data.status !== "RUNNING")),
    );
    return {
      reason: e.view > owner.view ? "VIEW_SUPERSEDED" : "EPOCH_TERMINAL",
      at:
        e.view === owner.view
          ? (e.finishedAt ?? transition?.at)
          : transition?.at,
    };
  }
  const deadline =
    owner.deadline ?? (e?.view === owner.view ? e?.deadline : undefined);
  if (deadline !== undefined && deadline <= now)
    return { reason: "DEADLINE", at: deadline };
}
export function reconcileResearchTasks(db: Store, now = Date.now()) {
  db.transaction(() => {
    for (const task of db.all<ResearchTask>("research-task")) {
      if (task.status !== "ACTIVE") continue;
      const attempts = db
        .all<ResearchAttempt>("research-attempt")
        .filter(
          (a) => a.taskId === task.id || a.id.startsWith(`${task.id}:attempt:`),
        );
      // New writes commit both terminal rows together. Only FAILED evidence can
      // repair the historical crash boundary; never finalize a resumable RUNNING row.
      const last = attempts.find(
        (a) =>
          a.id === `${task.id}:attempt:${task.maxAttempts - 1}` &&
          a.status === "FAILED",
      );
      const stop =
        closure(db, task, now) ??
        (last ? { reason: "EXHAUSTED", at: last.finishedAt } : undefined);
      if (stop)
        db.put("research-task", task.id, {
          ...task,
          status: "FAILED",
          finishedAt: stop.at ?? now,
          terminalReason: stop.reason,
        });
    }
  });
}
export interface Strike {
  id: string;
  agent: string;
  eventAt?: number;
  taskFinishedAt?: number;
  offendingAttemptIds: string[];
  provenance: string;
}
export function researchStrikes(db: Store, now: number): Strike[] {
  const groups = new Map<string, ResearchAttempt[]>();
  const strikes: Strike[] = [];
  for (const a of db.all<ResearchAttempt>("research-attempt")) {
    const match = /^(.*):attempt:(0|[1-9]\d*)$/.exec(a.id);
    if (!match || (a.taskId !== undefined && a.taskId !== match[1])) {
      if (a.status === "FAILED" && a.failure === "INVALID_OUTPUT")
        strikes.push({
          id: `unresolved:${a.id}`,
          agent: a.agent,
          offendingAttemptIds: [a.id],
          provenance: "unresolved",
        });
      continue;
    }
    const key = match[1]!;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  for (const [key, attempts] of groups) {
    const task = db.get<ResearchTask>("research-task", key);
    const owner = task ?? ownership(db, key);
    // Unknown ownership cannot establish new blame, but is unresolved evidence
    // for reconciliation of an existing operational quarantine.
    const hashes = new Set(attempts.map((a) => a.contextHash).filter(Boolean));
    const consistent =
      hashes.size <= 1 &&
      (!task || !hashes.size || hashes.has(task.contextHash));
    if (
      consistent &&
      (task?.status === "DONE" || attempts.some((a) => a.status === "DONE"))
    )
      continue;
    const stop = task
      ? task.status === "FAILED"
        ? { at: task.finishedAt }
        : undefined
      : owner
        ? closure(db, owner, now)
        : undefined;
    if (owner && consistent && !stop) continue;
    for (const agent of new Set(
      attempts
        .filter((a) => a.status === "FAILED" && a.failure === "INVALID_OUTPUT")
        .map((a) => a.agent),
    )) {
      const bad = attempts.filter(
        (a) =>
          a.agent === agent &&
          a.status === "FAILED" &&
          a.failure === "INVALID_OUTPUT",
      );
      const times = bad.map((a) => {
        if (Number.isFinite(a.finishedAt))
          return { at: a.finishedAt!, source: "finishedAt" };
        const h = history(db, "research-attempt", a.id).find(
          (r) =>
            r.operation !== "BASELINE" &&
            r.data.status === "FAILED" &&
            r.data.failure === "INVALID_OUTPUT",
        );
        if (h && Number.isFinite(h.at)) return { at: h.at, source: "history" };
        const incident = db.get<any>("incident", `research:${a.id}`);
        return Number.isFinite(incident?.at) && !incident?.timestampUnresolved
          ? { at: incident.at as number, source: "observed-time" }
          : undefined;
      });
      const resolved = !!owner && consistent && times.every(Boolean);
      strikes.push({
        id: `task:${key}:${agent}`,
        agent,
        eventAt: resolved ? Math.max(...times.map((t) => t!.at)) : undefined,
        taskFinishedAt: stop?.at,
        offendingAttemptIds: bad.map((a) => a.id).sort(),
        provenance: resolved
          ? [...new Set(times.map((t) => t!.source))].sort().join(",")
          : "unresolved",
      });
    }
  }
  return strikes;
}
