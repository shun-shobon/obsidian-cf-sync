import * as Y from "yjs";

import { t } from "../../i18n";
import { documentKey } from "../domain/storage-keys";
import type { LocalFile } from "../domain/sync-state";
import type { StoredData, SyncStore } from "../ports/sync-store";

export interface BorrowedDoc {
	doc: Y.Doc;
	/** Closes the document only if `borrow` opened it, leaving editor-held documents open. */
	release(): void;
}

export class Documents {
	private readonly docs = new Map<string, Y.Doc>();
	private readonly queuedVectors = new WeakMap<Y.Doc, Uint8Array>();
	private readonly references = new Map<Y.Doc, number>();

	constructor(
		private readonly store: SyncStore,
		private readonly onEdit: (file: LocalFile, doc: Y.Doc) => void,
		private readonly onRemap: (doc: Y.Doc, fileId: string) => void,
	) {}

	get(id: string): Y.Doc | undefined {
		return this.docs.get(id);
	}

	async open(file: LocalFile): Promise<Y.Doc> {
		const existing = this.docs.get(file.id);
		if (existing) {
			return existing;
		}

		const doc = new Y.Doc();
		const stored = await this.store.get(documentKey(file.id));
		if (stored) {
			Y.applyUpdate(doc, stored, "remote");
		}

		this.docs.set(file.id, doc);
		this.queuedVectors.set(doc, Y.encodeStateVector(doc));
		doc.on("update", (_update: Uint8Array, origin: unknown) => {
			const isEditorUpdate = origin !== "remote" && origin !== "capture";
			if (isEditorUpdate) {
				this.onEdit(file, doc);
			}
		});

		return doc;
	}

	async borrow(file: LocalFile): Promise<BorrowedDoc> {
		const wasOpen = this.docs.has(file.id);
		const doc = await this.open(file);
		const release = () => {
			if (!wasOpen) {
				this.remove(file.id);
			}
		};

		return { doc, release };
	}

	queuedVector(doc: Y.Doc): Uint8Array {
		return this.queuedVectors.get(doc)!;
	}

	markQueued(doc: Y.Doc, update: Uint8Array): void {
		this.queuedVectors.set(doc, Y.encodeStateVectorFromUpdate(update));
	}

	async retain(file: LocalFile): Promise<Y.Doc> {
		const doc = await this.open(file);
		this.references.set(doc, (this.references.get(doc) ?? 0) + 1);

		return doc;
	}

	/** Ends one editor's hold immediately; `closeUnused` runs later because queued work may still use the document. */
	release(doc: Y.Doc): void {
		const count = this.references.get(doc);
		if (count === undefined) {
			return;
		}

		if (count > 1) {
			this.references.set(doc, count - 1);

			return;
		}

		this.references.delete(doc);
	}

	isRetained(id: string): boolean {
		const doc = this.docs.get(id);

		return doc !== undefined && this.references.has(doc);
	}

	closeUnused(doc: Y.Doc): void {
		if (this.references.has(doc)) {
			return;
		}

		for (const [id, current] of this.docs) {
			if (current === doc) {
				this.remove(id);

				return;
			}
		}
	}

	remove(id: string): void {
		this.docs.get(id)?.destroy();
		this.docs.delete(id);
	}

	async remap(oldId: string, file: LocalFile): Promise<StoredData | undefined> {
		const doc = this.docs.get(oldId);
		if (doc) {
			this.docs.delete(oldId);
			this.docs.set(file.id, doc);
			this.onRemap(doc, file.id);

			return { key: documentKey(file.id), value: Y.encodeStateAsUpdate(doc) };
		}

		if (file.kind !== "text") {
			return undefined;
		}

		const stored = await this.store.get(documentKey(oldId));
		if (!stored) {
			throw new Error(t(($) => $.errors.missingCrdt));
		}

		return { key: documentKey(file.id), value: stored };
	}

	dispose(): void {
		for (const doc of this.docs.values()) {
			doc.destroy();
		}

		this.docs.clear();
		this.references.clear();
	}
}
