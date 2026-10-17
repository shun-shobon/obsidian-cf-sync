import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { LocalState } from "@cf-sync/sync-core/sync/domain/sync-state";
import type { StoredData, SyncStore } from "@cf-sync/sync-core/sync/ports/sync-store";

export class SqliteStore implements SyncStore {
	private readonly db: DatabaseSync;

	constructor(path: string, dryRun = false) {
		this.db = openDatabase(path, dryRun);
	}

	load(): Promise<LocalState | undefined> {
		const row = this.db.prepare("SELECT value FROM state WHERE id = 1").get();

		if (!row) {
			return Promise.resolve(undefined);
		}

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 自分で保存したJSONで、LocalStateのスキーマ検証は未導入
		return Promise.resolve(JSON.parse(String(row["value"])) as LocalState);
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

	get(key: string): Promise<Uint8Array | undefined> {
		const row = this.db.prepare("SELECT value FROM data WHERE key = ?").get(key);

		if (!row) {
			return Promise.resolve(undefined);
		}

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- value列はBLOB NOT NULLなので常にUint8Array
		return Promise.resolve(row["value"] as Uint8Array);
	}

	put(key: string, value: Uint8Array): Promise<void> {
		this.db.prepare("INSERT OR REPLACE INTO data VALUES (?, ?)").run(key, value);

		return Promise.resolve();
	}

	delete(key: string): Promise<void> {
		this.db.prepare("DELETE FROM data WHERE key = ?").run(key);

		return Promise.resolve();
	}

	close(): void {
		this.db.close();
	}
}

function openDatabase(path: string, dryRun: boolean): DatabaseSync {
	if (!dryRun) {
		return createDatabase(path);
	}

	if (existsSync(path)) {
		return new DatabaseSync(path, { readOnly: true });
	}

	// A dry run before the first sync must not leave state.sqlite behind.
	return createDatabase(":memory:");
}

function createDatabase(path: string): DatabaseSync {
	const db = new DatabaseSync(path);

	db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
  `);

	return db;
}
