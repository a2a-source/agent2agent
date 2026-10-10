import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";

test("history preserves transitions and deletion atomically, including direct SQL", () => {
  const db = new Store(":memory:");
  try {
    db.put("epoch", "1", { state: "OPEN" });
    db.put("epoch", "1", { state: "DONE" });
    db.put("epoch", "1", { state: "DONE" });
    assert.throws(() =>
      db.transaction(() => {
        db.put("epoch", "1", { state: "FAILED" });
        throw Error("rollback");
      }),
    );
    db.sql
      .prepare("DELETE FROM records WHERE kind=? AND id=?")
      .run("epoch", "1");
    const rows = db.sql
      .prepare("SELECT operation,data FROM record_history ORDER BY sequence")
      .all();
    assert.deepEqual(
      rows.map((r) => [r.operation, JSON.parse(String(r.data)).state]),
      [
        ["INSERT", "OPEN"],
        ["UPDATE", "DONE"],
        ["DELETE", "DONE"],
      ],
    );
    assert.throws(
      () => db.sql.exec("DELETE FROM record_history"),
      /append-only/,
    );
    assert.throws(
      () => db.sql.exec("UPDATE record_history SET kind='other'"),
      /append-only/,
    );
  } finally {
    db.close();
  }
});

test("legacy migration creates one baseline and survives restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-history-"));
  const path = join(dir, "state.sqlite");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(
      `CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id)); INSERT INTO records VALUES('epoch','old','{"state":"DONE"}');`,
    );
    legacy.close();
    let db = new Store(path);
    assert.equal(
      db.sql.prepare("SELECT operation FROM record_history").get()!.operation,
      "BASELINE",
    );
    db.put("epoch", "old", { state: "ARCHIVED" });
    db.close();
    db = new Store(path);
    assert.equal(
      db.sql.prepare("SELECT COUNT(*) AS n FROM record_history").get()!.n,
      2,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
