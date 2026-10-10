import { Store } from "./store.js";
import type { Epoch } from "./epochs.js";
import type { Agent } from "./agents.js";
import { PerformanceLedger } from "./performance-ledger.js";
/** Durable round accounting coverage; absent valuation adapters produce explicit UNKNOWN, never fictitious returns. */
export class RoundPerformanceCapture {
  readonly ledger: PerformanceLedger;
  constructor(
    readonly db: Store,
    readonly chainId: number,
  ) {
    this.ledger = new PerformanceLedger(db);
  }
  tick(now = Date.now()) {
    const epochs = this.db
      .all<Epoch>("epoch")
      .filter((e) => e.status === "PUBLISHED" || e.status === "FAILED")
      .sort((a, b) => a.slot - b.slot);
    let priorEnd: number | undefined;
    let missingPriorBoundary = false;
    for (const e of epochs) {
      const knownEnd = e.finishedAt;
      const end = knownEnd ?? now;
      const existing = this.ledger.latest(e.id, this.chainId);
      if (existing) {
        missingPriorBoundary = existing.agents.some((a) =>
          a.missingReasons.includes("ROUND_END_TIME_UNKNOWN"),
        );
        priorEnd = missingPriorBoundary ? undefined : existing.windowEndMs;
        continue;
      }
      if (end > now) continue;
      const members = this.db
        .all<Agent>("agent")
        .filter((a) => a.createdAt <= end);
      const roster = members.map((a) => ({ agentId: a.id, wallet: a.wallet }));
      if (!roster.length) continue;
      this.ledger.recordRound({
        version: "performance-input/1",
        currency: "micro-USDT",
        roundId: e.id,
        chainId: this.chainId,
        windowStartMs: Math.min(
          priorEnd !== undefined && priorEnd < end
            ? priorEnd
            : Math.min(...members.map((a) => a.createdAt)),
          end - 1,
        ),
        windowEndMs: end,
        observedAt: now,
        roster,
        perAgent: roster.map((a) => ({
          agentId: a.agentId,
          openingNAV: null,
          closingNAV: null,
          netCapitalFlow: null,
          cashflowComplete: false,
          missingReasons: [
            "CONFIRMED_VALUATION_AND_FLOW_ADAPTER_PENDING",
            ...(missingPriorBoundary ||
            (priorEnd !== undefined && priorEnd >= end)
              ? ["ROUND_START_TIME_UNKNOWN"]
              : []),
            ...(priorEnd === undefined
              ? ["OPENING_BOUNDARY_BASELINE_ONLY"]
              : []),
            ...(knownEnd === undefined ? ["ROUND_END_TIME_UNKNOWN"] : []),
          ],
          investments: [],
        })),
      });
      priorEnd = knownEnd;
      missingPriorBoundary = knownEnd === undefined;
    }
  }
}
