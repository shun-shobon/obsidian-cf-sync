import { history, undoDepth } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fromUint8Array } from "js-base64";
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { collaborationExtension } from "../src/presentation/editor/collaboration-extension";
import { presenceExtension } from "../src/presentation/editor/presence-extension";
import { Presence } from "../src/sync/service/presence";

const clients: Presence[] = [];
const views: EditorView[] = [];
const docs: Y.Doc[] = [];
function documentWith(text: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  docs.push(doc);
  return doc;
}
function pane(doc: Y.Doc, awareness?: Awareness, extensions: Extension[] = []) {
  const view = new EditorView({
    state: EditorState.create({
      doc: doc.getText("content").toString(),
      extensions: [history(), collaborationExtension(doc, awareness), ...extensions],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const client of clients.splice(0)) client.dispose();
  for (const doc of docs.splice(0)) doc.destroy();
  vi.restoreAllMocks();
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

describe("live cursor editor", () => {
  it("renders the remote selection and device name while preserving their relative positions", () => {
    const doc = documentWith("日本語のノート");
    const client = new Presence({ deviceId: "local", name: "Mac", send: vi.fn() });
    clients.push(client);
    const view = pane(doc, client.getAwareness("note", doc));
    const position = (index: number) =>
      fromUint8Array(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(doc.getText("content"), index),
        ),
      );
    client.receive({
      type: "presence",
      deviceId: "peer",
      clientId: 123,
      name: "iPhone",
      fileId: "note",
      cursor: { anchor: position(1), head: position(3) },
    });
    expect(view.dom.querySelector(".cm-ySelection")?.textContent).toBe("本語");
    expect(view.dom.querySelector(".cm-ySelectionInfo")?.textContent).toBe("iPhone");
    doc.getText("content").insert(0, "追記");
    expect(view.dom.querySelector(".cm-ySelection")?.textContent).toBe("本語");
    client.receive({
      type: "presence",
      deviceId: "peer",
      clientId: 123,
      name: "iPad",
      fileId: "note",
      cursor: { anchor: position(1), head: position(3) },
    });
    expect(view.dom.querySelector(".cm-ySelectionInfo")?.textContent).toBe("iPad");
    client.disconnect();
    expect(view.dom.querySelector(".cm-ySelectionCaret")).toBeNull();
  });

  it("publishes only the focused pane and clears on blur, hidden and editor destruction", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const doc = documentWith("共同編集");
    const send = vi.fn();
    const client = new Presence({ deviceId: "local", name: "Mac", send });
    clients.push(client);
    client.connect();
    const awareness = client.getAwareness("note", doc);
    const engine = {
      setSelection: client.setSelection.bind(client),
      clearSelection: client.clearSelection.bind(client),
    };
    const first = pane(doc, awareness, [presenceExtension(doc, engine)]);
    const second = pane(doc, awareness, [presenceExtension(doc, engine)]);
    first.focus();
    await Promise.resolve();
    expect(send.mock.lastCall?.[0].cursor).not.toBeNull();
    first.contentDOM.blur();
    expect(send.mock.lastCall?.[0].cursor).toBeNull();
    second.focus();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(send.mock.lastCall?.[0].cursor).not.toBeNull();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send.mock.lastCall?.[0].cursor).toBeNull();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(send.mock.lastCall?.[0].cursor).not.toBeNull();
    second.destroy();
    views.splice(views.indexOf(second), 1);
    expect(send.mock.lastCall?.[0].cursor).toBeNull();
  });
});
