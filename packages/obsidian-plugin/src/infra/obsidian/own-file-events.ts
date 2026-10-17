import { digest } from "@cf-sync/protocol";
import type { TFile, Vault } from "obsidian";

export type FileEvent =
	| { type: "create" | "modify" | "delete"; file: TFile; path: string }
	| { type: "rename"; file: TFile; path: string; oldPath: string };

export interface ContentEvent {
	type: "create" | "modify";
	path: string;
	digest: string;
}

type FileOperationEvent =
	| { type: "delete"; file: TFile; path: string }
	| { type: "rename"; file: TFile; path: string; oldPath: string };

export class OwnFileEvents {
	private readonly contentEvents = new Set<ContentEvent>();
	private readonly fileOperations = new Set<FileOperationEvent>();

	constructor(private readonly vault: Vault) {}

	/** Consume an expected event when it arrives, including after its API call resolves. */
	async isOwnEvent(event: FileEvent): Promise<boolean> {
		if (event.type === "create" || event.type === "modify") {
			return await this.consumeContentEvent(event);
		}

		for (const entry of this.fileOperations) {
			if (!matchesFileOperation(entry, event)) {
				continue;
			}

			this.fileOperations.delete(entry);

			return true;
		}

		return false;
	}

	private async consumeContentEvent(event: FileEvent): Promise<boolean> {
		const candidates = [...this.contentEvents].filter(
			(entry) => entry.type === event.type && entry.path === event.path,
		);

		if (candidates.length === 0) {
			return false;
		}

		if (this.vault.getAbstractFileByPath(event.path) !== event.file) {
			return false;
		}

		const content = new Uint8Array(await this.vault.readBinary(event.file));
		const hash = await digest(content);

		for (const entry of candidates) {
			if (entry.digest !== hash) {
				continue;
			}

			if (this.contentEvents.delete(entry)) {
				return true;
			}
		}

		// Different content means an external edit. Remove old markers so a later
		// external edit back to the previous content is not mistaken for our write.
		for (const entry of candidates) {
			this.contentEvents.delete(entry);
		}

		return false;
	}

	async expectContent<T>(event: ContentEvent, operation: () => Promise<T>): Promise<T> {
		return await runExpecting(this.contentEvents, event, operation);
	}

	async expectFileOperation<T>(event: FileOperationEvent, operation: () => Promise<T>): Promise<T> {
		return await runExpecting(this.fileOperations, event, operation);
	}

	discardContent(event: ContentEvent) {
		this.contentEvents.delete(event);
	}
}

async function runExpecting<E, T>(
	expected: Set<E>,
	event: E,
	operation: () => Promise<T>,
): Promise<T> {
	expected.add(event);
	try {
		return await operation();
	} catch (error) {
		expected.delete(event);
		throw error;
	}
}

function matchesFileOperation(entry: FileOperationEvent, event: FileEvent): boolean {
	if (entry.type !== event.type) {
		return false;
	}

	if (entry.file !== event.file) {
		return false;
	}

	if (event.type === "rename") {
		return entry.type === "rename" && entry.oldPath === event.oldPath;
	}

	return entry.path === event.path;
}
