import type { Operation } from "@cf-sync/protocol";
import type { LocalFile, LocalState } from "@cf-sync/sync-core/sync/domain/sync-state";
import type { StoredData, SyncStore } from "@cf-sync/sync-core/sync/ports/sync-store";

import { t } from "../../i18n";

interface PendingEntry {
	order: number;
	operation: Operation;
}

type StoredMetadata = Omit<LocalState, "files" | "pending">;

function unchanged(previous: object | undefined, current: object): boolean {
	if (!previous) {
		return false;
	}

	return Object.entries(current).every(([key, value]) => Reflect.get(previous, key) === value);
}

function storageFailed(cause: unknown): Error {
	return new Error(
		t(($) => $.errors.storageFailed),
		{ cause },
	);
}

/* oxlint-disable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion -- IndexedDB results are untyped, but only hold values this store wrote */
function resultOf<T>(request: IDBRequest): T {
	return request.result as T;
}
/* oxlint-enable typescript/no-unnecessary-type-parameters, typescript/no-unsafe-type-assertion */

async function requestResult<T>(request: IDBRequest): Promise<T> {
	return await new Promise((resolve, reject) => {
		request.addEventListener("success", () => resolve(resultOf<T>(request)));
		request.addEventListener("error", () => reject(storageFailed(request.error)));
	});
}

async function transactionDone(transaction: IDBTransaction): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		transaction.addEventListener("complete", () => resolve());
		transaction.addEventListener("abort", () =>
			reject(
				new Error(
					t(($) => $.errors.storageAborted),
					{ cause: transaction.error },
				),
			),
		);
		transaction.addEventListener("error", () => reject(storageFailed(transaction.error)));
	});
}

async function openDatabase(name: string): Promise<IDBDatabase> {
	return await new Promise((resolve, reject) => {
		const request = indexedDB.open(name, 1);

		request.addEventListener("upgradeneeded", () => {
			request.result.createObjectStore("sync");
			request.result.createObjectStore("files");
			request.result.createObjectStore("pending");
		});
		request.addEventListener("success", () => resolve(request.result));
		request.addEventListener("error", () => reject(storageFailed(request.error)));
		request.addEventListener("blocked", () => reject(new Error(t(($) => $.errors.databaseBusy))));
	});
}

/** Baselines and outbox entries are separate records: saving an edit never rewrites all note bodies. */
export class IndexedDbStore implements SyncStore {
	private readonly database: Promise<IDBDatabase>;
	private files = new Map<string, LocalFile>();
	private pending = new Map<string, PendingEntry>();
	private nextOrder = 0;

	constructor(name: string) {
		this.database = openDatabase(name);
	}

	async load(): Promise<LocalState | undefined> {
		const db = await this.database;
		const transaction = db.transaction(["sync", "files", "pending"], "readonly");
		const state = transaction.objectStore("sync").get("state");
		const files = transaction.objectStore("files").getAll();
		const pending = transaction.objectStore("pending").getAll();

		await transactionDone(transaction);

		const metadata = resultOf<StoredMetadata | undefined>(state);

		if (!metadata) {
			return undefined;
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

		return {
			...metadata,
			files: storedFiles,
			pending: entries.map((entry) => entry.operation),
		};
	}

	async save(state: LocalState, data?: StoredData): Promise<void> {
		const db = await this.database;
		const nextFiles = new Map(state.files.map((file) => [file.id, { ...file }]));
		const nextPending = new Map<string, PendingEntry>();

		for (const operation of state.pending) {
			const order = this.pending.get(operation.opId)?.order ?? this.nextOrder++;
			nextPending.set(operation.opId, { order, operation: { ...operation } });
		}

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

		await transactionDone(transaction);

		this.files = nextFiles;
		this.pending = nextPending;
	}

	async get(key: string): Promise<Uint8Array | undefined> {
		const db = await this.database;
		const request = db.transaction("sync", "readonly").objectStore("sync").get(`data:${key}`);

		return await requestResult<Uint8Array | undefined>(request);
	}

	async put(key: string, value: Uint8Array): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction("sync", "readwrite");
		transaction.objectStore("sync").put(value, `data:${key}`);

		await transactionDone(transaction);
	}

	async delete(key: string): Promise<void> {
		const db = await this.database;
		const transaction = db.transaction("sync", "readwrite");
		transaction.objectStore("sync").delete(`data:${key}`);

		await transactionDone(transaction);
	}

	close(): void {
		void this.database.then((db) => db.close());
	}
}
