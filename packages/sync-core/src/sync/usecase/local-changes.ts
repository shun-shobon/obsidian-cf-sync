import { digest, fileKind, isExcluded, pathSchema } from "@cf-sync/protocol";
import type { Content } from "@cf-sync/protocol";
import { fromUint8Array } from "js-base64";
import { equalFlat } from "lib0/array";
import * as v from "valibot";
import * as Y from "yjs";

import { blobKey, documentKey } from "../domain/storage-keys";
import type { LocalFile } from "../domain/sync-state";
import type { StoredData } from "../ports/sync-store";
import type { VaultPort } from "../ports/vault-port";
import type { BorrowedDoc, Documents } from "../service/documents";
import { appendContent, contentOperation } from "../service/pending-operations";
import type { SyncState } from "../service/sync-state";
import { replaceText } from "../service/text";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface TextState {
	doc: Y.Doc;
	update: Uint8Array;
}

export class LocalChanges {
	constructor(
		private readonly state: SyncState,
		private readonly vault: VaultPort,
		private readonly documents: Documents,
		private readonly onQueued: () => void,
	) {}

	async scan(): Promise<void> {
		const paths = await this.vault.list();
		const byPath = new Map(this.state.data.files.map((file) => [file.path, file]));
		for (const path of paths) {
			await this.captureFile(path, byPath.get(path));
		}

		if (!this.state.data.initialized) {
			return;
		}

		const present = new Set(paths);
		for (const file of this.state.data.files) {
			if (!present.has(file.path)) {
				await this.delete(file.path, file);
			}
		}
	}

	async rename(oldPath: string, path: string): Promise<void> {
		const file = this.state.data.files.find((candidate) => candidate.path === oldPath);
		if (!file) {
			await this.capture(path);

			return;
		}

		if (isExcluded(path, this.state.data.exclusions)) {
			return;
		}

		v.parse(pathSchema, path);
		file.path = path;
		this.state.data.pending.push({
			type: "move",
			opId: crypto.randomUUID(),
			fileId: file.id,
			basePathRevision: file.pathRevision,
			path,
		});
		await this.state.persist();
	}

	async delete(path: string, known?: LocalFile): Promise<void> {
		const file = known ?? this.state.data.files.find((candidate) => candidate.path === path);
		if (!file || isExcluded(path, this.state.data.exclusions)) {
			return;
		}

		const alreadyQueued = this.state.data.pending.some(
			(operation) => operation.fileId === file.id && operation.type === "delete",
		);
		if (alreadyQueued) {
			return;
		}

		this.state.data.pending.push({
			type: "delete",
			opId: crypto.randomUUID(),
			fileId: file.id,
			baseRevision: file.revision,
		});
		await this.state.persist();
	}

	async capture(path: string): Promise<void> {
		const known = this.state.data.files.find((file) => file.path === path);
		await this.captureFile(path, known);
	}

	async editorChanged(file: LocalFile, doc: Y.Doc): Promise<void> {
		const bytes = encoder.encode(doc.getText("content").toString());
		// Writing here would make Obsidian merge the file into its unsaved buffer; the editor saves it instead.
		await this.queueContent(file, bytes, await digest(bytes), doc);
	}

	private async captureFile(path: string, known: LocalFile | undefined): Promise<void> {
		if (isExcluded(path, this.state.data.exclusions)) {
			return;
		}

		v.parse(pathSchema, path);

		const bytes = await this.vault.read(path);
		const hash = await digest(bytes);
		if (known && (await this.reconcileDiskBaseline(known, hash))) {
			return;
		}

		const file = known ?? this.addFile(path, hash);
		await this.captureContent(file, bytes, hash);
	}

	private async reconcileDiskBaseline(file: LocalFile, hash: string): Promise<boolean> {
		if (file.digest === hash) {
			await this.recordDisk(file, hash);

			return true;
		}

		if (file.kind !== "text") {
			return false;
		}

		// An editor save can be older than the document. Obsidian merges external writes into the
		// editor itself, so they reach the document through the editor binding.
		if (this.documents.isRetained(file.id)) {
			await this.recordDisk(file, hash);

			return true;
		}

		// The editor never saved the document's latest text, e.g. Obsidian quit first. Capturing
		// the older disk text would revert edits that may already be sent.
		if (hash === file.diskDigest) {
			await this.restoreDisk(file);

			return true;
		}

		return false;
	}

	private async recordDisk(file: LocalFile, hash: string): Promise<void> {
		if (file.diskDigest === hash) {
			return;
		}

		file.diskDigest = hash;
		await this.state.persist();
	}

	private async restoreDisk(file: LocalFile): Promise<void> {
		const borrowed = await this.documents.borrow(file);
		const bytes = encoder.encode(borrowed.doc.getText("content").toString());
		borrowed.release();
		await this.vault.write(file.path, bytes);
		file.diskDigest = await digest(bytes);
		await this.state.persist();
	}

	private addFile(path: string, hash: string): LocalFile {
		const file: LocalFile = {
			id: crypto.randomUUID(),
			path,
			digest: "",
			diskDigest: hash,
			documentRevision: 0,
			kind: fileKind(path),
			revision: 0,
			pathRevision: 0,
		};
		this.state.data.files.push(file);

		return file;
	}

	private async captureContent(file: LocalFile, bytes: Uint8Array, hash: string): Promise<void> {
		let borrowed: BorrowedDoc | undefined;
		if (file.kind === "text") {
			borrowed = await this.documents.borrow(file);
			replaceText(borrowed.doc, decoder.decode(bytes), "capture");
		}

		file.diskDigest = hash;
		await this.queueContent(file, bytes, hash, borrowed?.doc);
		borrowed?.release();
	}

	private async queueContent(
		file: LocalFile,
		bytes: Uint8Array,
		hash: string,
		doc: Y.Doc | undefined,
	): Promise<void> {
		let text: TextState | undefined;
		if (doc) {
			text = { doc, update: Y.encodeStateAsUpdate(doc) };
		}

		if (file.digest === hash && !this.hasNewStructs(text)) {
			return;
		}

		const { content, savedData } = this.prepareContent(file, bytes, hash, text);
		const operation = contentOperation(this.state.data, file, content);
		file.digest = hash;
		appendContent(this.state.data, operation);
		await this.state.persist(savedData);
		if (text) {
			this.documents.markQueued(text.doc, text.update);
		}
		this.onQueued();
	}

	private hasNewStructs(text: TextState | undefined): boolean {
		if (!text) {
			return false;
		}

		const vector = Y.encodeStateVectorFromUpdate(text.update);

		return !equalFlat(vector, this.documents.queuedVector(text.doc));
	}

	private prepareContent(
		file: LocalFile,
		bytes: Uint8Array,
		hash: string,
		text: TextState | undefined,
	): { content: Content; savedData: StoredData } {
		if (text) {
			let sendingUpdate = text.update;
			if (file.revision > 0) {
				sendingUpdate = Y.diffUpdate(text.update, this.documents.queuedVector(text.doc));
			}

			return {
				savedData: { key: documentKey(file.id), value: text.update },
				content: { kind: "text", update: fromUint8Array(sendingUpdate) },
			};
		}

		const key = crypto.randomUUID();

		return {
			savedData: { key: blobKey(key), value: bytes },
			content: { kind: "blob", blob: { key, size: bytes.length, digest: hash } },
		};
	}
}
