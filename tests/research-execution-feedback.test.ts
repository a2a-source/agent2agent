import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { ExecutionFeedback } from "../src/execution-feedback.js";
import {
  collectExecutionFeedbackEvidence,
  contextTools,
} from "../src/research-data.js";
import { contextSchema, promptSnapshot } from "../src/research-context.js";
import { stableFixture } from "./helpers/stable-qsp.js";
import { hash } from "../src/protocol.js";
const wallet = "0x0000000000000000000000000000000000000001";
function record(
  db: Store,
  roundId: string,
  chainId: number,
  finishedAt: number,
) {
  const f = new ExecutionFeedback(db);
  const row = f.recordWallet({
    roundId,
    chainId,
    agentId: "agent",
    wallet,
    jobId: "job",
    planId: "plan",
    openingSnapshotId: null,
    closingSnapshotId: null,
    fillIds: [],
  });
  f.recordNetwork({
    roundId,
    chainId,
    expectedWallets: [wallet],
    memberObservationIds: [row.id],
  });
  db.put("investment-execution-round", roundId, {
    roundId,
    chainId,
    status: "COMPLETE",
    finishedAt,
  });
}
test("research feedback selects latest completed same-chain past round and persists provenance", () => {
  const db = new Store(":memory:");
  try {
    assert.equal(collectExecutionFeedbackEvidence(db, 56, 100), null);
    record(db, "old", 56, 10);
    record(db, "latest", 56, 20);
    record(db, "other", 97, 30);
    record(db, "future", 56, 101);
    db.put("investment-execution-round", "pending", {
      roundId: "pending",
      chainId: 56,
      status: "RUNNING",
      finishedAt: 40,
    });
    const result = collectExecutionFeedbackEvidence(db, 56, 100)!;
    assert.equal(result.feedback.roundId, "latest");
    assert.equal(result.feedback.network?.status, "UNKNOWN");
    assert.equal(result.feedback.network?.periodPnlMicros, null);
    const persisted = db.get<any>("research-evidence", result.evidence.id)!;
    assert.equal(result.evidence.kind, "accounting");
    assert.equal(result.evidence.asOf, 20);
    assert.equal(persisted.data.roundId, "latest");
    assert.equal(result.evidence.contentHash, hash(persisted.data));
  } finally {
    db.close();
  }
});
test("signed context and role snapshots retain USD feedback references and reject invented UNKNOWN profit", async () => {
  const db = new Store(":memory:");
  try {
    record(db, "r", 56, 20);
    const feedback = collectExecutionFeedbackEvidence(db, 56, 100)!;
    const { context } = await stableFixture();
    const combined = {
      ...context,
      executionFeedback: feedback.feedback,
      evidence: [...context.evidence, feedback.evidence],
    };
    const parsed = contextSchema.parse(combined);
    assert.notEqual(hash(parsed), hash(context));
    const prompt = promptSnapshot(parsed) as any;
    assert.equal(prompt.executionFeedback.currency, "micro-USD");
    assert.equal(prompt.executionFeedback.network.periodPnlMicros, null);
    assert.match(prompt.units, /micro-USD/);
    const tool = contextTools(parsed, "positions").find(
      (t) => t.name === "research_snapshot",
    )!;
    const toolResult = (await tool.run({})) as any;
    assert.equal(toolResult.data.executionFeedback.roundId, "r");
    assert.throws(() =>
      contextSchema.parse({
        ...combined,
        executionFeedback: {
          ...feedback.feedback,
          network: { ...feedback.feedback.network, periodPnlMicros: "100" },
        },
      }),
    );
    assert.throws(() =>
      contextSchema.parse({
        ...combined,
        executionFeedback: { ...feedback.feedback, chainId: 97 },
      }),
    );
    assert.throws(() =>
      contextSchema.parse({
        ...combined,
        executionFeedback: { ...feedback.feedback, unexpected: "instruction" },
      }),
    );
  } finally {
    db.close();
  }
});
