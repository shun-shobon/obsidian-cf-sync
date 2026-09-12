import { Compartment, type Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";

import { EditorBinding, type EditorDocuments } from "./editor-binding";

export function editorExtension(
  getEngine: () => EditorDocuments | undefined,
  report: (error: unknown) => void,
): Extension {
  const slot = new Compartment();

  return [
    slot.of([]),
    ViewPlugin.define((view) => new EditorBinding(view, slot, getEngine, report)),
  ];
}
