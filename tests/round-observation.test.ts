import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { hash } from "../src/protocol.js";
import {
  freezeTerminalObservationRoster,
  publishRoundObservation,
} from "../src/round-observation.js";
import { PerformanceLedger } from "../src/performance-ledger.js";
const wallet = "0x" + "11".repeat(20);
export function emptyObservation() {
  return {
    chainId: 97,
    roundId: "1",
    sourceStatus: "FAILED" as const,
    terminalAt: 1000,
    observedAt: 2000,
    roster: [{ agentId: "a", wallet }],
    rosterComplete: true,
    predecessorId: null,
    registryHash: null,
    configHash: hash({}),
    openingBoundary: null,
    closingBoundary: null,
    lifecycle: "PENDING" as const,
    wallets: [
      {
        agentId: "a",
        wallet,
        openingSnapshotId: null,
        closingSnapshotId: null,
        proofIds: [],
        captureAttemptIds: [],
        missingReasons: ["OPENING_BASELINE_UNAVAILABLE"],
      },
    ],
    missingReasons: [],
  };
}
test("observation publication is atomic, immutable, currency isolated and CAS guarded", () => {
  const db = new Store(":memory:");
  try {
    const input = emptyObservation(),
      first = publishRoundObservation(db, input, null);
    assert.deepEqual(publishRoundObservation(db, input, null), first);
    assert.equal(
      new PerformanceLedger(db).latest("1", 97, "micro-USD")?.network.periodPnL,
      null,
    );
    assert.equal(new PerformanceLedger(db).latest("1", 97), undefined);
    assert.throws(
      () => publishRoundObservation(db, { ...input, observedAt: 3000 }, null),
      /CONFLICT/,
    );
    const final = publishRoundObservation(
      db,
      { ...input, lifecycle: "COMPLETE", observedAt: 3000 },
      first.id,
    );
    assert.equal(final.revision, 2);
    assert.equal(
      db.get<any>("round-observation", first.id)?.lifecycle,
      "PENDING",
    );
    assert.throws(
      () =>
        publishRoundObservation(
          db,
          {
            ...input,
            roundId: "forged",
            wallets: [
              { ...input.wallets[0]!, closingSnapshotId: "a".repeat(64) },
            ],
          },
          null,
        ),
      /SNAPSHOT/,
    );
  } finally {
    db.close();
  }
});
test("terminal roster freezes original identities without changing signed epoch", () => {
  const db = new Store(":memory:");
  try {
    db.put("agent", "a", { id: "a", wallet, createdAt: 0 });
    const e: any = {
      id: "1",
      status: "FAILED",
      finishedAt: 1000,
      output: { allocation: null },
      signature: "signature",
    };
    const before = hash(e);
    freezeTerminalObservationRoster(db, e);
    db.remove("agent", "a");
    freezeTerminalObservationRoster(db, e);
    assert.equal(hash(e), before);
    assert.equal(
      db.get<any>("round-observation-terminal", "1").roster[0].wallet,
      wallet,
    );
  } finally {
    db.close();
  }
});
