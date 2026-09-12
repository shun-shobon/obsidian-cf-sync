import { EditorState, Transaction, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
const managers = new WeakMap<Y.Doc, Y.UndoManager>();
export function collaborationExtension(doc: Y.Doc): Extension {
  let undoManager = managers.get(doc);
  if (!undoManager) {
    undoManager = new Y.UndoManager(doc.getText("content"), { trackedOrigins: new Set() });
    managers.set(doc, undoManager);
    const manager = undoManager;
    doc.on("destroy", () => manager.destroy());
  }
  return [
    yCollab(doc.getText("content"), null, { undoManager }),
    EditorState.transactionExtender.of(() => ({ annotations: Transaction.addToHistory.of(false) })),
    Prec.highest(
      keymap.of(
        yUndoManagerKeymap.map((binding) => ({
          ...binding,
          run: (view) => {
            binding.run?.(view);
            return true;
          },
        })),
      ),
    ),
    Prec.highest(
      EditorView.domEventHandlers({
        beforeinput(event, view) {
          if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
          const binding = yUndoManagerKeymap[event.inputType === "historyUndo" ? 0 : 1];
          binding?.run?.(view);
          event.preventDefault();
          return true;
        },
      }),
    ),
  ];
}
