import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type * as Y from "yjs";

import { collaborationExtension } from "./binding";
export interface EditorDocuments {
  ensureDoc(path: string): Promise<Y.Doc | undefined>;
  releaseDoc(doc: Y.Doc): void;
  getDoc(path: string): Y.Doc | undefined;
}
export function editorExtension(
  getEngine: () => EditorDocuments | undefined,
  report: (error: unknown) => void,
): Extension {
  const slot = new Compartment();
  return [
    slot.of([]),
    ViewPlugin.fromClass(
      class {
        private path?: string;
        private doc?: Y.Doc;
        private boundEngine?: EditorDocuments;
        private binding = false;
        private retry = false;
        private disposed = false;
        private scheduled = false;
        constructor(private readonly view: EditorView) {
          this.schedule();
        }
        update(_update: ViewUpdate) {
          this.schedule();
        }
        private schedule() {
          if (this.disposed) return;
          if (this.binding) {
            this.retry = true;
            return;
          }
          if (this.scheduled) return;
          this.scheduled = true;
          queueMicrotask(() => {
            this.scheduled = false;
            this.binding = true;
            void this.bind()
              .catch(report)
              .finally(() => {
                this.binding = false;
                if (this.retry) {
                  this.retry = false;
                  this.schedule();
                }
              });
          });
        }
        private async bind() {
          const path = this.view.state.field(editorInfoField, false)?.file?.path;
          const engine = getEngine();
          if (path && path === this.path && this.doc && engine?.getDoc(path) === this.doc) return;
          if (this.doc) {
            const oldDoc = this.doc;
            this.doc = undefined;
            this.view.dispatch({ effects: slot.reconfigure([]) });
            this.boundEngine?.releaseDoc(oldDoc);
            this.boundEngine = undefined;
          }
          this.path = path;
          if (!path || !engine || !path.endsWith(".md")) return;
          const doc = await engine.ensureDoc(path);
          if (!doc) return;
          if (
            this.disposed ||
            getEngine() !== engine ||
            this.view.state.field(editorInfoField, false)?.file?.path !== path
          ) {
            engine.releaseDoc(doc);
            return;
          }
          // Never overwrite an editor buffer just to attach a CRDT binding. Vault capture
          // reconciles divergent contents; a later editor update retries attachment.
          if (this.view.state.doc.toString() !== doc.getText("content").toString()) {
            engine.releaseDoc(doc);
            return;
          }
          this.doc = doc;
          this.boundEngine = engine;
          this.view.dispatch({ effects: slot.reconfigure(collaborationExtension(doc)) });
        }
        destroy() {
          this.disposed = true;
          if (this.doc) this.boundEngine?.releaseDoc(this.doc);
        }
      },
    ),
  ];
}
