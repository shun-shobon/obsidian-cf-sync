import { fileKind } from "@cf-sync/protocol";
import type { Compartment } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { collaborationExtension } from "./collaboration-extension";
import { presenceExtension } from "./presence-extension";

export interface EditorDocuments {
	ensureDoc(path: string, attach: (doc: Y.Doc) => boolean): Promise<Y.Doc | undefined>;
	releaseDoc(doc: Y.Doc): void;
	getDoc(path: string): Y.Doc | undefined;
	getAwareness(doc: Y.Doc): Awareness | undefined;
	setSelection(owner: object, doc: Y.Doc, anchor: number, head: number): void;
	clearSelection(owner: object): void;
}

export class EditorBinding {
	private path?: string;
	private doc?: Y.Doc;
	private boundEngine?: EditorDocuments;
	private dirty = false;
	private running?: Promise<void>;
	private disposed = false;

	constructor(
		private readonly view: EditorView,
		private readonly slot: Compartment,
		private readonly getEngine: () => EditorDocuments | undefined,
		private readonly report: (error: unknown) => void,
	) {
		this.schedule();
	}

	update() {
		this.schedule();
	}

	private schedule() {
		this.dirty = true;
		this.running ??= this.drain();
	}

	private async drain() {
		// Binding dispatches, which CodeMirror rejects during the update that scheduled it.
		// Waiting a microtask also merges updates from the same dispatch into one bind.
		await Promise.resolve();

		while (this.dirty && !this.disposed) {
			this.dirty = false;
			await this.bind().catch(this.report);
		}

		this.running = undefined;
	}

	private currentPath() {
		return this.view.state.field(editorInfoField, false)?.file?.path;
	}

	private unbind() {
		if (!this.doc) {
			return;
		}

		const oldDoc = this.doc;
		this.doc = undefined;
		this.view.dispatch({ effects: this.slot.reconfigure([]) });
		this.boundEngine?.releaseDoc(oldDoc);
		this.boundEngine = undefined;
	}

	private async bind() {
		const path = this.currentPath();
		const engine = this.getEngine();

		if (this.isCurrentBinding(path, engine)) {
			return;
		}

		this.unbind();
		this.path = path;

		if (path === undefined || !engine) {
			return;
		}

		if (fileKind(path) !== "text") {
			return;
		}

		await engine.ensureDoc(path, (doc) => this.attach(engine, path, doc));
	}

	private attach(engine: EditorDocuments, path: string, doc: Y.Doc): boolean {
		if (!this.canAttach(engine, path, doc)) {
			return false;
		}

		this.doc = doc;
		this.boundEngine = engine;
		this.view.dispatch({
			effects: this.slot.reconfigure([
				collaborationExtension(doc, engine.getAwareness(doc)),
				presenceExtension(doc, engine),
			]),
		});

		return true;
	}

	private isCurrentBinding(path: string | undefined, engine: EditorDocuments | undefined): boolean {
		if (path === undefined || !this.doc) {
			return false;
		}

		if (path !== this.path) {
			return false;
		}

		return engine?.getDoc(path) === this.doc;
	}

	private canAttach(engine: EditorDocuments, path: string, doc: Y.Doc): boolean {
		if (this.disposed) {
			return false;
		}

		if (this.getEngine() !== engine) {
			return false;
		}

		if (this.currentPath() !== path) {
			return false;
		}

		// Buffer reconciliation belongs to vault capture. Attaching a binding must not
		// replace local editor contents that have not been captured yet.
		return this.view.state.doc.toString() === doc.getText("content").toString();
	}

	destroy() {
		this.disposed = true;

		if (this.doc) {
			this.boundEngine?.releaseDoc(this.doc);
		}
	}
}
