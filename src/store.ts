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
