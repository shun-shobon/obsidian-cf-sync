import { history, undoDepth } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

import { collaborationExtension } from "../src/plugin/editor/binding";
const views: EditorView[] = [];
const docs: Y.Doc[] = [];
function documentWith(text: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  docs.push(doc);
  return doc;
}
function pane(doc: Y.Doc) {
  const view = new EditorView({
    state: EditorState.create({
      doc: doc.getText("content").toString(),
      extensions: [history(), collaborationExtension(doc)],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const doc of docs.splice(0)) doc.destroy();
});
describe("CodeMirror Yjs binding", () => {
  it("keeps remote changes out of native editor undo history", () => {
    const doc = documentWith("A");
    const view = pane(doc);
    doc.transact(() => doc.getText("content").insert(1, "remote"), "remote");
    expect(undoDepth(view.state)).toBe(0);
    const event = new InputEvent("beforeinput", {
      inputType: "historyUndo",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("Aremote");
  });

  it("shares edits across two panes without duplicating text", () => {
    const doc = documentWith("始");
    const first = pane(doc);
    const second = pane(doc);
    first.dispatch({ changes: { from: 1, insert: "日本語" } });
    expect(second.state.doc.toString()).toBe("始日本語");
    second.dispatch({ changes: { from: 4, insert: "入力" } });
    expect(first.state.doc.toString()).toBe("始日本語入力");
    expect(doc.getText("content").toString()).toBe("始日本語入力");
  });
  it("undoes this device edit while preserving remote text", () => {
    const doc = documentWith("A");
    const remote = new Y.Doc();
    docs.push(remote);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const view = pane(doc);
    view.dispatch({ changes: { from: 1, insert: "local" } });
    remote.getText("content").insert(0, "remote");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote), "remote");
    expect(view.state.doc.toString()).toContain("local");
    expect(yUndoManagerKeymap[0]!.run!(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("remoteA");
  });
  it("records Japanese composition-style replacement transactions without lost text", () => {
    const doc = documentWith("");
    const first = pane(doc);
    const second = pane(doc);
    first.dispatch({ changes: { from: 0, insert: "に" } });
    first.dispatch({ changes: { from: 0, to: 1, insert: "日本" } });
    first.dispatch({ changes: { from: 0, to: 2, insert: "日本語" } });
    expect(second.state.doc.toString()).toBe("日本語");
    expect(doc.getText("content").toString()).toBe("日本語");
  });
});
