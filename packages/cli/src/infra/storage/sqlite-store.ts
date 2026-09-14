import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { LocalState, StoredData, SyncStore } from "@cf-sync/sync-core";

export class SqliteStore implements SyncStore {
  private readonly db: DatabaseSync;
  private readonly temporary: string | undefined;

  constructor(path: string, dryRun = false) {
    if (dryRun && existsSync(path)) {
      this.temporary = mkdtempSync(join(tmpdir(), "cf-sync-plan-"));
      const copy = join(this.temporary, "state.sqlite");

      copyFileSync(path, copy);

      if (existsSync(path + "-wal")) {
        copyFileSync(path + "-wal", copy + "-wal");
      }

      this.db = new DatabaseSync(copy);
      return;
    }

    let databasePath = path;

    if (dryRun) {
      databasePath = ":memory:";
    }

    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
    `);
  }

  async load(): Promise<LocalState | undefined> {
    const row = this.db.prepare("SELECT value FROM state WHERE id = 1").get();

    if (!row) {
      return undefined;
    }

    return JSON.parse(String(row["value"])) as LocalState;
  }

  async save(state: LocalState, data?: StoredData): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");

    try {
      if (data) {
        await this.put(data.key, data.value);
      }

      this.db.prepare("INSERT OR REPLACE INTO state VALUES (1, ?)").run(JSON.stringify(state));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const row = this.db.prepare("SELECT value FROM data WHERE key = ?").get(key);

    if (!row) {
      return undefined;
    }

    return row["value"] as Uint8Array;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO data VALUES (?, ?)").run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM data WHERE key = ?").run(key);
  }

  close(): void {
    this.db.close();

    if (this.temporary) {
      rmSync(this.temporary, { recursive: true });
    }
  }
}
