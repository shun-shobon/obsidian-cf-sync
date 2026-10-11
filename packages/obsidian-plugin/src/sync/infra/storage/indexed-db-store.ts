import type { Operation } from "@cf-sync/protocol";
import type { LocalFile, LocalState } from "@cf-sync/sync-core/sync/domain/sync-state";
import type { StoredData, SyncStore } from "@cf-sync/sync-core/sync/ports/sync-store";

import { t } from "../../../i18n";

interface PendingEntry {
	order: number;
	operation: Operation;
}

function unchanged(previous: object | undefined, current: object): boolean {
	if (!previous) {
		return false;
	}

	return Object.entries(current).every(([key, value]) => Reflect.get(previous, key) === value);
}

/* oxlint-disable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion -- IndexedDB results are untyped, but only hold values this store wrote */
function resultOf<T>(request: IDBRequest): T {
	return request.result as T;
}
/* oxlint-enable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion */

/** Baselines and outbox entries are separate records: saving an edit never rewrites all note bodies. */
export class IndexedDbStore implements SyncStore {
	private readonly database: Promise<IDBDatabase>;
	private files = new Map<string, LocalFile>();
	private pending = new Map<string, PendingEntry>();
	private nextOrder = 0;

	constructor(name: string) {
		this.database = new Promise((resolve, reject) => {
			const request = indexedDB.open(name, 1);
			request.addEventListener("upgradeneeded", () => {
				request.result.createObjectStore("sync");
				request.result.createObjectStore("files");
				request.result.createObjectStore("pending");
			});
			request.addEventListener("success", () => resolve(request.result));
			request.addEventListener("error", () =>
				reject(
					new Error(
						t(($) => $.errors.storageFailed),
						{ cause: request.error },
					),
				),
			);
			request.addEventListener("blocked", () => reject(new Error(t(($) => $.errors.databaseBusy))));
		});
	}

	private async read<T>(key: string): Promise<T | undefined> {
		const db = await this.database;

		return await new Promise((resolve, reject) => {
			const transaction = db.transaction("sync", "readonly");
			const store = transaction.objectStore("sync");
			const request = store.get(key);
			request.addEventListener("success", () => resolve(resultOf<T | undefined>(request)));
			request.addEventListener("error", () =>
				reject(
					new Error(
						t(($) => $.errors.storageFailed),
						{ cause: request.error },
					),
				),
			);
		});
	}

	private async write(key: string, value: unknown, remove = false): Promise<void> {
		const db = await this.database;

		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction("sync", "readwrite");
			const store = transaction.objectStore("sync");
			if (remove) {
				store.delete(key);
			} else {
				store.put(value, key);
			}

			transaction.addEventListener("complete", () => resolve());
			transaction.addEventListener("abort", () =>
				reject(
					new Error(
						t(($) => $.errors.storageAborted),
						{ cause: transaction.error },
					),
				),
			);
			transaction.addEventListener("error", () =>
				reject(
					new Error(
						t(($) => $.errors.storageFailed),
						{ cause: transaction.error },
					),
				),
			);
		});
	}

	async load(): Promise<LocalState | undefined> {
		const db = await this.database;

		return await new Promise((resolve, reject) => {
			const transaction = db.transaction(["sync", "files", "pending"], "readonly");
			const state = transaction.objectStore("sync").get("state");
			const files = transaction.objectStore("files").getAll();
			const pending = transaction.objectStore("pending").getAll();
			transaction.addEventListener("complete", () => {
				const metadata = resultOf<Omit<LocalState, "files" | "pending"> | undefined>(state);
				if (!metadata) {
					resolve(undefined);

					return;
				}

				const entries = resultOf<PendingEntry[]>(pending);
				entries.sort((a, b) => a.order - b.order);
				const storedFiles = resultOf<LocalFile[]>(files);
				this.files = new Map(storedFiles.map((file) => [file.id, { ...file }]));
				this.pending = new Map(
					entries.map((entry) => [
						entry.operation.opId,
						{ order: entry.order, operation: { ...entry.operation } },
					]),
				);
				this.nextOrder = 0;
				if (entries.length > 0) {
					const existingOrders = entries.map((entry) => entry.order);
					this.nextOrder = Math.max(...existingOrders) + 1;
				}

				resolve({
					...metadata,
					files: storedFiles,
					pending: entries.map((entry) => entry.operation),
				});
			});
			transaction.addEventListener("error", () =>
				reject(
					new Error(
						t(($) => $.errors.storageFailed),
						{ cause: transaction.error },
					),
				),
			);
		});
	}

	async save(state: LocalState, data?: StoredData): Promise<void> {
		const db = await this.database;
		const nextFiles = new Map(state.files.map((file) => [file.id, { ...file }]));
		const nextPending = new Map<string, PendingEntry>();
		for (const operation of state.pending) {
			const order = this.pending.get(operation.opId)?.order ?? this.nextOrder++;
			nextPending.set(operation.opId, { order, operation: { ...operation } });
		}

		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction(["sync", "files", "pending"], "readwrite");
			const store = transaction.objectStore("sync");
			const { files: _files, pending: _pending, ...metadata } = state;
			store.put(metadata, "state");
			const files = transaction.objectStore("files");
			for (const [id, file] of nextFiles) {
				if (!unchanged(this.files.get(id), file)) {
					files.put(file, id);
				}
			}

			for (const id of this.files.keys()) {
				if (!nextFiles.has(id)) {
					files.delete(id);
				}
			}

			const pending = transaction.objectStore("pending");
			for (const [id, entry] of nextPending) {
				if (!unchanged(this.pending.get(id)?.operation, entry.operation)) {
					pending.put(entry, id);
				}
			}

			for (const id of this.pending.keys()) {
				if (!nextPending.has(id)) {
					pending.delete(id);
				}
			}

			if (data) {
				store.put(data.value, `data:${data.key}`);
			}

			transaction.addEventListener("complete", () => resolve());
			transaction.addEventListener("abort", () =>
				reject(
					new Error(
						t(($) => $.errors.storageAborted),
						{ cause: transaction.error },
					),
				),
			);
			transaction.addEventListener("error", () =>
				reject(
					new Error(
						t(($) => $.errors.storageFailed),
						{ cause: transaction.error },
					),
				),
			);
		});
		this.files = nextFiles;
		this.pending = nextPending;
	}

	get(key: string): Promise<Uint8Array | undefined> {
		return this.read(`data:${key}`);
	}

	put(key: string, value: Uint8Array): Promise<void> {
		return this.write(`data:${key}`, value);
	}

	delete(key: string): Promise<void> {
		return this.write(`data:${key}`, undefined, true);
	}

	close(): void {
		void this.database.then((db) => db.close());
	}
}
