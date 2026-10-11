import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
export class Store {
  readonly sql: DatabaseSync;
  private depth = 0;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.sql.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS metadata(version INTEGER NOT NULL); INSERT INTO metadata SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM metadata);`);
    // Capture transitions in SQLite itself so direct SQL and rollback obey the
    // same history guarantees as Store.put/remove. Legacy state is a baseline,
    // not a reconstruction of events that occurred before this migration.
    this.transaction(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS record_history(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL, id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK(operation IN ('BASELINE','INSERT','UPDATE','DELETE')),
          data TEXT NOT NULL CHECK(json_valid(data)),
          recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS record_history_entity ON record_history(kind,id,sequence);
        CREATE TABLE IF NOT EXISTS store_migrations(name TEXT PRIMARY KEY);
        INSERT INTO record_history(kind,id,operation,data)
          SELECT kind,id,'BASELINE',data FROM records
          WHERE NOT EXISTS(SELECT 1 FROM store_migrations WHERE name='record-history-v1');
        INSERT OR IGNORE INTO store_migrations VALUES('record-history-v1');
        CREATE TRIGGER IF NOT EXISTS records_history_insert AFTER INSERT ON records BEGIN
          INSERT INTO record_history(kind,id,operation,data) VALUES(NEW.kind,NEW.id,'INSERT',NEW.data);
        END;
        CREATE TRIGGER IF NOT EXISTS records_history_update AFTER UPDATE ON records
          WHEN OLD.data != NEW.data OR OLD.kind != NEW.kind OR OLD.id != NEW.id BEGIN
          INSERT INTO record_history(kind,id,operation,data)
            SELECT OLD.kind,OLD.id,'DELETE',OLD.data WHERE OLD.kind != NEW.kind OR OLD.id != NEW.id;
          INSERT INTO record_history(kind,id,operation,data) VALUES(NEW.kind,NEW.id,'UPDATE',NEW.data);
        END;
        CREATE TRIGGER IF NOT EXISTS records_history_delete AFTER DELETE ON records BEGIN
          INSERT INTO record_history(kind,id,operation,data) VALUES(OLD.kind,OLD.id,'DELETE',OLD.data);
        END;
        CREATE TRIGGER IF NOT EXISTS history_no_update BEFORE UPDATE ON record_history BEGIN
          SELECT RAISE(ABORT,'record history is append-only');
        END;
        CREATE TRIGGER IF NOT EXISTS history_no_delete BEFORE DELETE ON record_history BEGIN
          SELECT RAISE(ABORT,'record history is append-only');
        END;
      `);
    });
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.sql
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  all<T>(kind: string): T[] {
    return this.sql
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY id")
      .all(kind)
      .map((r) => JSON.parse(r.data as string));
  }
  entries<T>(kind: string): { id: string; data: T }[] {
    return this.sql
      .prepare("SELECT id,data FROM records WHERE kind=? ORDER BY id")
      .all(kind)
      .map((row) => ({
        id: row.id as string,
        data: JSON.parse(row.data as string),
      }));
  }
  remove(kind: string, id: string) {
    this.sql.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  put(kind: string, id: string, data: unknown) {
    this.sql
      .prepare(
        "INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, id, JSON.stringify(data));
  }
  insert(kind: string, id: string, data: unknown) {
    this.sql
      .prepare("INSERT INTO records VALUES(?,?,?)")
      .run(kind, id, JSON.stringify(data));
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.sql.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const v = fn();
      if (v instanceof Promise) throw Error("transactions must be synchronous");
      this.sql.exec("COMMIT");
      return v;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
  close() {
    this.sql.close();
  }
}
