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
          switch (event.inputType) {
            case "historyUndo":
              yUndoManagerKeymap[0]?.run?.(view);
              break;
            case "historyRedo":
              yUndoManagerKeymap[1]?.run?.(view);
              break;
            default:
              return false;
          }

          event.preventDefault();

          return true;
        },
      }),
    ),
  ];
}
