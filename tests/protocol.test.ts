import { test } from "node:test";
import assert from "node:assert/strict";
import { elect, canonical, hash, leader } from "../src/protocol.js";
import { Epochs } from "../src/epochs.js";
import { Store } from "../src/store.js";
const candidates = Array.from({ length: 45 }, (_, i) => ({
  id: `a${String(i).padStart(2, "0")}`,
  wallet: `0x${i.toString(16).padStart(40, "0")}`,
  stake: "300000000000000000",
  compute: "10000",
}));
test("committee election is reproducible independent of input order and contains unique workers", () => {
  const a = elect(candidates, "term:1", 7),
    b = elect([...candidates].reverse(), "term:1", 7);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((x) => x.id)).size, 7);
  assert.equal(leader(a, 0, 0).id, a[0]!.id);
  assert.equal(leader(a, 1, 0).id, a[1]!.id);
  assert.equal(leader(a, 0, 1).id, a[1]!.id);
  assert.equal(elect(candidates.slice(0, 3), "x", 7).length, 3);
  assert.equal(elect(candidates.slice(0, 6), "x", 7).length, 6);
  assert.throws(() => elect(candidates.slice(0, 2), "x", 7), /three/);
  assert.throws(
    () => elect([...candidates, candidates[0]!], "x", 7),
    /duplicate/,
  );
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.throws(() => canonical({ a: NaN }));
});
test("epoch CAS takeover fences old master and restart retains one final output", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  const e = epochs.open(
    0,
    candidates.slice(0, 7),
    { termSlots: 7, committeeSize: 7, timeoutMs: 1000 },
    0,
  );
  assert.throws(() => epochs.takeover(e.id, 0, 999), /deadline/);
  const next = epochs.takeover(e.id, 0, 1001);
  assert.equal(next.view, 1);
  assert.notEqual(next.master, e.master);
  assert.throws(() => epochs.takeover(e.id, 0, 1002), /stale/);
  assert.throws(
    () => epochs.publish(e.id, 0, e.master, { signals: [] }, "sig", 1100),
    /stale/,
  );
  epochs.publish(e.id, 1, next.master, { signals: [] }, "sig", 1100);
  assert.equal(new Epochs(db).get(e.id).status, "PUBLISHED");
  assert.throws(
    () => epochs.publish(e.id, 1, next.master, { signals: [1] }, "sig2", 1100),
    /published/,
  );
  db.close();
});
test("platform incidents never create a financial debit and evidence is idempotent", () => {
  const db = new Store(":memory:"),
    epochs = new Epochs(db);
  epochs.incident("failure-1", "a", "PLATFORM_TIMEOUT", 100);
  epochs.incident("failure-1", "a", "PLATFORM_TIMEOUT", 100);
  assert.equal(db.all("incident").length, 1);
  assert.equal(db.all("slash").length, 0);
  db.close();
});
test("expanded committee configuration returns the requested number of distinct candidates", () => {
  assert.equal(elect(candidates, "expanded", 30).length, 30);
});
