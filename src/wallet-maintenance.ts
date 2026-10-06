import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  linkSync,
  unlinkSync,
  existsSync,
  writeFileSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { WalletVault, type EncryptedWallet } from "./wallet.js";
export interface WalletMaintenanceOptions {
  batchSize?: number;
  backupDirectory?: string;
  backupIntervalMs?: number;
  maxBackups?: number;
}
/** Checks SQLite and proves possession of every encrypted wallet; never returns key material. */
export async function verifyWalletBackup(
  path: string,
  vault: WalletVault,
): Promise<void> {
  const sql = new DatabaseSync(path, { readOnly: true });
  try {
    sql.exec("BEGIN");
    const integrity = sql.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw Error("backup integrity failure");
    const rows = sql
      .prepare("SELECT id,data FROM records WHERE kind='wallet'")
      .all();
    const wallets = new Map<string, EncryptedWallet>();
    for (const row of rows) {
      const wallet = JSON.parse(row.data as string) as EncryptedWallet;
      await vault.verify(wallet);
      wallets.set(row.id as string, wallet);
    }
    for (const row of sql
      .prepare("SELECT id,data FROM records WHERE kind='agent'")
      .all()) {
      const agent = JSON.parse(row.data as string) as {
        id?: string;
        wallet?: string;
      };
      const wallet = wallets.get(row.id as string);
      if (
        agent.id !== row.id ||
        !wallet ||
        typeof agent.wallet !== "string" ||
        agent.wallet.toLowerCase() !== wallet.address.toLowerCase()
      )
        throw Error("agent wallet integrity failure");
    }
  } finally {
    sql.close();
  }
}
/** Restore only to an absent database. Call before Store startup, retaining all old keys. */
export async function restoreWalletBackup(
  source: string,
  target: string,
  vault: WalletVault,
): Promise<void> {
  if (
    existsSync(target) ||
    existsSync(target + "-wal") ||
    existsSync(target + "-shm")
  )
    throw Error("restore destination already exists");
  await verifyWalletBackup(source, vault);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), ".restore-" + randomUUID());
  try {
    writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
    const sourceSql = new DatabaseSync(source, { readOnly: true });
    try {
      sourceSql.prepare("VACUUM INTO ?").run(temporary);
    } finally {
      sourceSql.close();
    }
    await verifyWalletBackup(temporary, vault);
    linkSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export class WalletMaintenance {
  private running = false;
  private readonly batchSize: number;
  constructor(
    readonly db: Store,
    readonly vault: WalletVault,
    readonly options: WalletMaintenanceOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    if (
      !Number.isSafeInteger(options.maxBackups ?? 30) ||
      (options.maxBackups ?? 30) < 1
    )
      throw Error("invalid wallet backup retention");
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1)
      throw Error("invalid wallet migration batch size");
    if (
      options.backupIntervalMs !== undefined &&
      (!Number.isFinite(options.backupIntervalMs) ||
        options.backupIntervalMs <= 0)
    )
      throw Error("invalid wallet backup interval");
  }
  async rotateBatch(): Promise<{ migrated: number; remaining: number }> {
    // Ciphertext key IDs are the durable cursor; a failed batch changes nothing.
    const pending = this.db
      .entries<EncryptedWallet>("wallet")
      .filter((r) => r.data.keyId !== this.vault.keyId);
    const batch = pending.slice(0, this.batchSize);
    const replacement: {
      id: string;
      before: EncryptedWallet;
      after: EncryptedWallet;
    }[] = [];
    for (const row of batch) {
      await this.vault.verify(row.data);
      const after = this.vault.reencrypt(row.data);
      await this.vault.verify(after);
      replacement.push({ id: row.id, before: row.data, after });
    }
    return this.db.transaction(() => {
      for (const row of replacement) {
        if (
          JSON.stringify(this.db.get("wallet", row.id)) !==
          JSON.stringify(row.before)
        )
          throw Error("wallet changed during migration; retry");
        this.db.put("wallet", row.id, row.after);
      }
      return {
        migrated: batch.length,
        remaining: this.db
          .all<EncryptedWallet>("wallet")
          .filter((r) => r.keyId !== this.vault.keyId).length,
      };
    });
  }
  async backup(target: string): Promise<void> {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(target), ".backup-" + randomUUID());
    try {
      // VACUUM INTO creates a consistent SQLite snapshot, including committed WAL rows.
      writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
      this.db.sql.prepare("VACUUM INTO ?").run(temporary);
      await verifyWalletBackup(temporary, this.vault);
      linkSync(temporary, target);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  private retainBackups(current: string): void {
    const directory = this.options.backupDirectory!;
    const pattern =
      /^wallet-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/;
    const snapshots = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => ({
        name: entry.name,
        time: BigInt(pattern.exec(entry.name)![1]!),
      }))
      .sort((a, b) =>
        a.time === b.time
          ? b.name.localeCompare(a.name)
          : a.time > b.time
            ? -1
            : 1,
      );
    for (const snapshot of snapshots
      .filter((snapshot) => join(directory, snapshot.name) !== current)
      .slice((this.options.maxBackups ?? 30) - 1)) {
      const path = join(directory, snapshot.name);
      // A symlink substituted after listing is never a retention candidate.
      if (lstatSync(path).isFile()) unlinkSync(path);
    }
  }
  async tick(now = Date.now()): Promise<{
    migrated: number;
    remaining: number;
    backup?: string;
    busy?: boolean;
  }> {
    if (this.running) return { migrated: 0, remaining: 0, busy: true };
    this.running = true;
    try {
      const rotation = await this.rotateBatch();
      const last = this.db.get<{ at: number }>("maintenance", "wallet-backup");
      if (
        this.options.backupDirectory &&
        (!last ||
          now < last.at ||
          now - last.at >= (this.options.backupIntervalMs ?? 86400000))
      ) {
        const backup = join(
          this.options.backupDirectory,
          `wallet-${now}-${randomUUID()}.sqlite`,
        );
        await this.backup(backup);
        this.retainBackups(backup);
        this.db.put("maintenance", "wallet-backup", { at: now, path: backup });
        return { ...rotation, backup };
      }
      return rotation;
    } finally {
      this.running = false;
    }
  }
}
