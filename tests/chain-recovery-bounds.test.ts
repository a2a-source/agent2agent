import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type TxRecord } from "../src/chain.js";
import { Store } from "../src/store.js";

function seed(
  db: Store,
  prefix: string,
  count: number,
  state: TxRecord["state"],
) {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${String(i).padStart(3, "0")}`;
    db.put("transaction", id, {
      id,
      sender: "0x0000000000000000000000000000000000000001",
      intentHash: id,
      raw: "0x",
      hash: id,
      state,
      ...(state === "READY" ? {} : { block: 1, blockHash: "old" }),
    } satisfies TxRecord);
  }
}

function reader(seen: string[]) {
  return {
    getTransactionReceipt: async (hash: string) => {
      seen.push(hash);
      if (hash.startsWith("pending")) return null;
      return {
        hash,
        status: 1,
        blockNumber: 2,
        blockHash: "canonical",
        confirmations: async () => 2,
      };
    },
    getBlock: async () => ({ hash: "canonical" }),
  } as any;
}

test("recovery bounds terminal RPC work while giving pending transactions priority", async () => {
  const db = new Store(":memory:");
  try {
    seed(db, "audit", 100, "CONFIRMED");
    seed(db, "pending", 30, "READY");
    const seen: string[] = [];
    await new Journal(db, reader(seen), 97, false).recover(2);
    assert.equal(seen.length, 16);
    assert.equal(seen.filter((id) => id.startsWith("audit")).length, 4);
    assert.ok(seen.slice(0, 12).every((id) => id.startsWith("pending")));
    assert.equal(
      db.all<TxRecord>("transaction").filter((t) => t.block === 2).length,
      4,
    );
    assert.equal(db.all("transaction").length, 130);
  } finally {
    db.close();
  }
});

test("pending recovery rotates fairly even when earlier rows remain pending", async () => {
  const db = new Store(":memory:");
  try {
    seed(db, "pending", 40, "READY");
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const before = seen.length;
      await new Journal(db, reader(seen), 97, false).recover(2);
      assert.equal(seen.length - before, 16);
    }
    assert.equal(new Set(seen).size, 40);
    assert.ok(
      db.all<TxRecord>("transaction").every((t) => t.state === "READY"),
    );
  } finally {
    db.close();
  }
});

test("terminal audits resume their rotation after reopening the persistent database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "a2a-recovery-bounds-"));
  const path = join(directory, "state.sqlite");
  let db = new Store(path);
  try {
    seed(db, "audit", 10, "CONFIRMED");
    const seen: string[] = [];
    await new Journal(db, reader(seen), 97, false).recover(2);
    assert.deepEqual(seen, [
      "audit-000",
      "audit-001",
      "audit-002",
      "audit-003",
    ]);
    db.close();
    db = new Store(path);
    await new Journal(db, reader(seen), 97, false).recover(2);
    assert.deepEqual(seen.slice(4), [
      "audit-004",
      "audit-005",
      "audit-006",
      "audit-007",
    ]);
    await new Journal(db, reader(seen), 97, false).recover(2);
    assert.deepEqual(seen.slice(8), [
      "audit-008",
      "audit-009",
      "audit-000",
      "audit-001",
    ]);
    assert.ok(db.all<TxRecord>("transaction").every((t) => t.block === 2));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
