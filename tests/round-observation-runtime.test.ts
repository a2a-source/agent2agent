import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Store } from "../src/store.js";
import {
  createRoundObservationCapture,
  roundSettlementReady,
} from "../src/round-observation-runtime.js";
import { hash } from "../src/protocol.js";
test("production and source harness use shared observation factory independently from trading", async () => {
  const db = new Store(":memory:");
  try {
    const capture = createRoundObservationCapture(db, {
      chainId: 97,
      registry: null,
      executionEnabled: false,
      clock: () => 1000,
    });
    assert.ok(capture.observation);
    db.put("epoch", "1", { id: "1", status: "FAILED", finishedAt: 1 });
    await capture.tick();
    assert.equal(
      capture.ledger.latest("1", 97, "micro-USD")?.network.periodPnL,
      null,
    );
    assert.equal(db.all("round-observation").length, 2);
    for (const path of [
      "../src/main.ts",
      "../var/testnet/investment/full-network-e2e.ts",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, /createRoundObservationCapture\(db/);
    }
  } finally {
    db.close();
  }
});
test("read-only wait requires discovered planning and reconciled jobs only for real allocation", () => {
  const db = new Store(":memory:");
  try {
    const epoch: any = {
      id: "r",
      status: "PUBLISHED",
      output: { masterSummary: { stableNetworkAllocation: { targets: [] } } },
    };
    assert.equal(roundSettlementReady(db, 97, true, epoch), false);
    assert.equal(roundSettlementReady(db, 97, false, epoch), true);
    assert.equal(
      roundSettlementReady(db, 97, true, { ...epoch, status: "FAILED" }),
      true,
    );
    assert.equal(
      roundSettlementReady(db, 97, true, {
        ...epoch,
        output: { masterSummary: { stableNetworkAllocation: null } },
      }),
      true,
    );
    db.put("investment-planning-epoch", hash([97, "r"]), {
      status: "ELIGIBLE",
    });
    db.put("investment-planning-job", "p", {
      epoch: "r",
      status: "DONE",
      planId: "plan",
    });
    db.put("stable-wallet-plan", "plan", { status: "READY" });
    assert.equal(roundSettlementReady(db, 97, true, epoch), false);
    db.put("investment-execution-job", "j", {
      chainId: 97,
      roundId: "r",
      planId: "plan",
      status: "RECONCILING",
    });
    assert.equal(roundSettlementReady(db, 97, true, epoch), false);
    db.put("investment-execution-job", "j", {
      chainId: 97,
      roundId: "r",
      planId: "plan",
      status: "ABORTED",
    });
    assert.equal(roundSettlementReady(db, 97, true, epoch), true);
  } finally {
    db.close();
  }
});
