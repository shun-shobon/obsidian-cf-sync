import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type * as Y from "yjs";

import type { EditorDocuments } from "./editor-binding";

export function presenceExtension(
  doc: Y.Doc,
  engine: Pick<EditorDocuments, "setSelection" | "clearSelection">,
) {
  return ViewPlugin.fromClass(
    class {
      private readonly owner = {};
      private readonly document: Document;
      private readonly window: Window | null;
      private disposed = false;

      constructor(private readonly view: EditorView) {
        this.document = view.dom.ownerDocument;
        this.window = this.document.defaultView;
        this.window?.addEventListener("blur", this.clear);
        this.window?.addEventListener("focus", this.publish);
        this.document.addEventListener("visibilitychange", this.publish);
        view.contentDOM.addEventListener("focus", this.publish);
        view.contentDOM.addEventListener("blur", this.clear);
        // Installing the extension happens inside dispatch. Publish after the
        // transaction completes, once all panes have updated their bindings.
        queueMicrotask(this.publish);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          this.publish();
        }
      }

      private readonly clear = () => engine.clearSelection(this.owner);

      private readonly publish = () => {
        if (this.disposed) {
          return;
        }
        if (!this.view.hasFocus || !this.document.hasFocus() || this.document.hidden) {
          this.clear();
          return;
        }
        const { anchor, head } = this.view.state.selection.main;
        engine.setSelection(this.owner, doc, anchor, head);
      };

      destroy() {
        this.disposed = true;
        this.clear();
        this.window?.removeEventListener("blur", this.clear);
        this.window?.removeEventListener("focus", this.publish);
        this.document.removeEventListener("visibilitychange", this.publish);
        this.view.contentDOM.removeEventListener("focus", this.publish);
        this.view.contentDOM.removeEventListener("blur", this.clear);
      }
    },
  );
}
