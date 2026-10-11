import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { electFair, type FairElection } from "../src/fair-election.js";
import { hash } from "../src/protocol.js";
import { Store } from "../src/store.js";
import { Epochs } from "../src/epochs.js";
const nodes = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `a${String(i).padStart(3, "0")}`,
    wallet: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    stake: "300000000000000000",
    compute: "100000",
  }));
const config = {
  termSlots: 7,
  committeeSize: 7,
  timeoutMs: 60000,
  epochMs: 300000,
};
test("fair selection is input-order independent and extra stake cannot buy priority", () => {
  const input = nodes(60),
    counts = Object.fromEntries(input.map((c, i) => [c.id, i % 3]));
  const a = electFair(input, "seed", 7, counts);
  assert.deepEqual(a, electFair([...input].reverse(), "seed", 7, counts));
  const richer = input.map((c, i) => ({
    ...c,
    stake: String(BigInt(c.stake) * BigInt(i + 1)),
  }));
  assert.deepEqual(
    a.map((c) => c.id),
    electFair(richer, "seed", 7, counts).map((c) => c.id),
  );
  assert(a.every((c) => counts[c.id] === 0));
  assert.throws(
    () => electFair([...input, input[0]!], "seed", 7, counts),
    /duplicate/,
  );
  assert.throws(
    () => electFair(input, "seed", 7, { ...counts, a000: -1 }),
    /count/,
  );
  assert.throws(
    () => electFair(input, "seed", 7, { ...counts, a000: 0.1 }),
    /count/,
  );
  assert.throws(() => electFair(input.slice(0, 2), "seed", 7, {}), /three/);
});
test("60 qualifying nodes all rotate, with selection-count spread at most one over 600 terms", () => {
  const input = nodes(60),
    counts: Record<string, number> = {};
  for (let term = 0; term < 600; term++) {
    const committee = electFair(input, `term:${term}`, 7, counts);
    for (const c of committee) counts[c.id] = (counts[c.id] ?? 0) + 1;
    const values = input.map((c) => counts[c.id] ?? 0);
    assert(Math.max(...values) - Math.min(...values) <= 1);
  }
  assert.equal(Object.keys(counts).length, 60);
  assert(input.every((c) => counts[c.id] === 70));
});
test("term snapshots persist fairness history once, retain legacy committees and restore missing nodes' history", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-fair-")),
    path = join(dir, "db.sqlite"),
    input = nodes(10);
  let db = new Store(path),
    epochs = new Epochs(db);
  try {
    // Persist an actual pre-upgrade term without an election hash.
    const legacy = {
      committee: input.slice(0, 7),
      snapshotHash: hash(input),
      configHash: hash(config),
    };
    db.put("term", "0", legacy);
    const first = epochs.open(0, input, config, 1000);
    assert.deepEqual(first.committee, legacy.committee);
    assert.equal(first.electionHash, undefined);
    db.put("epoch", first.id, { ...first, status: "FAILED" });
    const same = epochs.open(1, input, config, 2000);
    assert.deepEqual(same.committee, legacy.committee);
    db.put("epoch", same.id, { ...same, status: "FAILED" });
    // Exclude one previously elected node in term1; it must keep its count when it returns.
    const next = epochs.open(7, input.slice(1), config, 3000);
    const proof = db.get<FairElection>("election", "1")!;
    assert.equal(next.electionHash, hash(proof));
    assert.equal(proof.version, "fair-terms/1");
    assert.equal(proof.participation.a001, 1);
    assert.equal(proof.participation.a007, 0);
    assert.equal(db.all("election").length, 1);
    assert.deepEqual(epochs.open(7, input, config), next);
    db.put("epoch", next.id, { ...next, status: "FAILED" });
    db.close();
    db = new Store(path);
    epochs = new Epochs(db);
    const restored = epochs.open(14, input, config, 4000),
      restoredProof = db.get<FairElection>("election", "2")!;
    assert.equal(restoredProof.participation.a000, 1);
    assert.deepEqual(
      electFair(
        restoredProof.candidates,
        restoredProof.seed,
        restoredProof.committeeSize,
        restoredProof.participation,
      ),
      restored.committee,
    );
    assert(restored.committee.some((c) => c.id === "a000"));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("three-node Master rotation does not restart at the first wallet every seven-slot term", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db),
    input = nodes(3),
    masters: Record<string, number> = {};
  try {
    for (let slot = 0; slot < 21; slot++) {
      const e = epochs.open(slot, input, config, slot * 1000);
      masters[e.master] = (masters[e.master] ?? 0) + 1;
      db.put("epoch", e.id, { ...e, status: "FAILED" });
    }
    assert.deepEqual(
      Object.values(masters).sort((a, b) => a - b),
      [7, 7, 7],
    );
  } finally {
    db.close();
  }
});
test("corrupt saved election proof cannot silently be reused in the same term", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db),
    input = nodes(10);
  try {
    const e = epochs.open(0, input, config, 1000);
    db.put("epoch", e.id, { ...e, status: "FAILED" });
    const proof = db.get<FairElection>("election", "0")!;
    db.put("election", "0", {
      ...proof,
      participation: { ...proof.participation, a000: 999 },
    });
    assert.throws(() => epochs.open(1, input, config, 2000), /election proof/);
  } finally {
    db.close();
  }
});
