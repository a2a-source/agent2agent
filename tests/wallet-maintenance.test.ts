import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WalletVault } from "../src/wallet.js";
import { Store } from "../src/store.js";
import {
  WalletMaintenance,
  restoreWalletBackup,
  verifyWalletBackup,
} from "../src/wallet-maintenance.js";
const key = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
const old = key(),
  next = key();
const ring = () =>
  new WalletVault(
    [
      { id: "old", publicPem: old.publicKey, privatePem: old.privateKey },
      { id: "new", publicPem: next.publicKey, privatePem: next.privateKey },
    ],
    "new",
  );
test("keyring validates pairs, strength and unavailable key versions", () => {
  assert.throws(
    () => new WalletVault(old.publicKey, next.privateKey, "bad"),
    /match/,
  );
  const weak = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  assert.throws(
    () => new WalletVault(weak.publicKey, weak.privateKey, "weak"),
    /2048/,
  );
  const record = new WalletVault(old.publicKey, old.privateKey, "old").create();
  assert.equal(
    ring().withWallet(record, (w) => w.address),
    record.address,
  );
  assert.throws(
    () =>
      new WalletVault(next.publicKey, next.privateKey, "new").withWallet(
        record,
        () => null,
      ),
    /unavailable/,
  );
});
test("migration resumes per batch, verifies identities and preserves ledger and transactions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-maint-"));
  let db = new Store(join(dir, "live.db"));
  try {
    const legacy = new WalletVault(old.publicKey, old.privateKey, "old");
    for (let i = 0; i < 3; i++) db.put("wallet", String(i), legacy.create());
    db.put("ledger", "cost", { amount: "17" });
    db.put("tx", "pending", { nonce: 9 });
    let m = new WalletMaintenance(db, ring(), { batchSize: 1 });
    assert.equal((await m.rotateBatch()).remaining, 2);
    db.close();
    db = new Store(join(dir, "live.db"));
    m = new WalletMaintenance(db, ring(), { batchSize: 2 });
    assert.equal((await m.rotateBatch()).remaining, 0);
    assert.ok(db.all<any>("wallet").every((w) => w.keyId === "new"));
    assert.deepEqual(db.get("ledger", "cost"), { amount: "17" });
    assert.deepEqual(db.get("tx", "pending"), { nonce: 9 });
    const backup = join(dir, "backups", "snapshot.db");
    await m.backup(backup);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    await verifyWalletBackup(backup, ring());
    await assert.rejects(verifyWalletBackup(backup, legacy));
    const restored = join(dir, "restored.db");
    await restoreWalletBackup(backup, restored, ring());
    await assert.rejects(
      restoreWalletBackup(backup, restored, ring()),
      /exist/i,
    );
    const copy = new Store(restored);
    assert.deepEqual(copy.get("tx", "pending"), { nonce: 9 });
    copy.close();
    const corrupt = join(dir, "corrupt.db");
    writeFileSync(corrupt, "broken");
    await assert.rejects(
      restoreWalletBackup(corrupt, join(dir, "bad.db"), ring()),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a bad wallet rolls back the entire migration batch", async () => {
  const db = new Store(":memory:");
  try {
    const legacy = new WalletVault(old.publicKey, old.privateKey, "old");
    db.put("wallet", "a", legacy.create());
    db.put("wallet", "b", {
      ...legacy.create(),
      address: "0x0000000000000000000000000000000000000000",
    });
    await assert.rejects(
      new WalletMaintenance(db, ring(), { batchSize: 2 }).rotateBatch(),
      /integrity/,
    );
    assert.equal(db.get<any>("wallet", "a").keyId, "old");
  } finally {
    db.close();
  }
});
test("periodic maintenance persists backup cadence across restart and rejects clobber", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-tick-"));
  const db = new Store(join(dir, "live.db"));
  try {
    db.put(
      "wallet",
      "one",
      new WalletVault(old.publicKey, old.privateKey, "old").create(),
    );
    const options = {
      backupDirectory: join(dir, "backups"),
      backupIntervalMs: 100,
      batchSize: 1,
    };
    const first = await new WalletMaintenance(db, ring(), options).tick(1000);
    assert.equal(first.migrated, 1);
    assert.ok(first.backup);
    assert.equal(
      (await new WalletMaintenance(db, ring(), options).tick(1050)).backup,
      undefined,
    );
    assert.ok(
      (await new WalletMaintenance(db, ring(), options).tick(1100)).backup,
    );
    await assert.rejects(
      new WalletMaintenance(db, ring()).backup(first.backup!),
    );
    await verifyWalletBackup(first.backup!, ring());
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("restore includes committed WAL rows from a live SQLite source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-wal-"));
  const source = join(dir, "source.db"),
    target = join(dir, "restored.db");
  const db = new Store(source);
  try {
    db.sql.exec("PRAGMA wal_autocheckpoint=0");
    db.put("wallet", "extra", ring().create());
    db.put("tx", "nonce", { nonce: 31 });
    await restoreWalletBackup(source, target, ring());
    const restored = new Store(target);
    try {
      assert.ok(restored.get("wallet", "extra"));
      assert.deepEqual(restored.get("tx", "nonce"), { nonce: 31 });
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("backup verification rejects agents with missing or misbound wallets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-binding-"));
  const path = join(dir, "live.db");
  const db = new Store(path);
  try {
    const record = ring().create();
    db.put("agent", "a", { id: "a", wallet: record.address });
    await assert.rejects(
      verifyWalletBackup(path, ring()),
      /agent wallet integrity/,
    );
    db.put("wallet", "a", ring().create());
    await assert.rejects(
      verifyWalletBackup(path, ring()),
      /agent wallet integrity/,
    );
    db.put("wallet", "a", record);
    await verifyWalletBackup(path, ring());
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("retention keeps newest usable owned backups and preserves unrelated files and symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-retain-"));
  const db = new Store(join(dir, "live.db"));
  const backups = join(dir, "backups");
  try {
    db.put("wallet", "one", ring().create());
    const m = new WalletMaintenance(db, ring(), {
      backupDirectory: backups,
      backupIntervalMs: 1,
      maxBackups: 2,
    });
    const first = (await m.tick(1000)).backup!;
    const second = (await m.tick(1001)).backup!;
    const unrelated = join(backups, "notes.txt");
    writeFileSync(unrelated, "keep");
    const incomplete = join(backups, ".backup-incomplete");
    writeFileSync(incomplete, "keep");
    const { symlinkSync, existsSync } = await import("node:fs");
    const link = join(
      backups,
      "wallet-999-12345678-1234-1234-1234-123456789abc.sqlite",
    );
    symlinkSync(unrelated, link);
    const newest = (await m.tick(1002)).backup!;
    assert.equal(existsSync(first), false);
    assert.ok(existsSync(second));
    assert.ok(existsSync(newest));
    assert.ok(existsSync(unrelated));
    assert.ok(existsSync(incomplete));
    assert.ok(existsSync(link));
    await verifyWalletBackup(newest, ring());
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("retention always preserves newly verified snapshot after clock rewind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wallet-rewind-"));
  const db = new Store(join(dir, "live.db"));
  try {
    const options = {
      backupDirectory: join(dir, "backups"),
      backupIntervalMs: 1,
      maxBackups: 1,
    };
    db.put("wallet", "one", ring().create());
    const previous = (
      await new WalletMaintenance(db, ring(), options).tick(2000)
    ).backup!;
    const fresh = (await new WalletMaintenance(db, ring(), options).tick(1000))
      .backup!;
    await verifyWalletBackup(fresh, ring());
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(previous), false);
    assert.equal(db.get<any>("maintenance", "wallet-backup").path, fresh);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
