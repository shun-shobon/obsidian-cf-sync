import type { ClientMessage, ServerMessage } from "@cf-sync/protocol";
import { Presence } from "@cf-sync/sync-core/sync/service/presence";
import { fromUint8Array, toUint8Array } from "js-base64";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

type Message = Extract<ServerMessage, { type: "presence" }>;
const docs: Y.Doc[] = [];
const clients: Presence[] = [];
function setup() {
  const send = vi.fn<(message: Extract<ClientMessage, { type: "presence" }>) => void>();
  const client = new Presence({ deviceId: "local", name: "Mac", send });
  clients.push(client);
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "日本語のノート");
  docs.push(doc);
  const awareness = client.getAwareness("note", doc);
  const position = (index: number) =>
    fromUint8Array(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(doc.getText("content"), index),
      ),
    );
  const message: Message = {
    type: "presence",
    deviceId: "peer",
    name: "iPhone",
    clientId: 123,
    fileId: "note",
    cursor: { anchor: position(1), head: position(3) },
  };
  return { client, doc, awareness, send, message };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  for (const doc of docs.splice(0)) doc.destroy();
  vi.useRealTimers();
});
describe("live cursor presence", () => {
  it("throttles moving selections to 20 Hz and sends the latest position", () => {
    const { client, doc, send } = setup();
    const owner = {};
    client.connect();
    client.setSelection(owner, doc, 0, 0);
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(8);
      client.setSelection(owner, doc, i, i);
    }
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    expect(send).toHaveBeenCalledTimes(2);
    const cursor = send.mock.lastCall![0].cursor!;
    const position = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(toUint8Array(cursor.head)),
      doc,
    );
    expect(position?.index).toBe(5);
  });

  it("does not let an old pane clear the new pane's cursor", () => {
    const { client, doc, send } = setup();
    const first = {},
      second = {};
    client.connect();
    client.setSelection(first, doc, 0, 0);
    client.setSelection(second, doc, 2, 3);
    client.clearSelection(first);
    vi.advanceTimersByTime(50);
    expect(send.mock.lastCall![0].cursor).not.toBeNull();
    client.clearSelection(second);
    expect(send.mock.lastCall![0]).toMatchObject({ fileId: null, cursor: null });
    vi.advanceTimersByTime(3_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("refreshes stationary cursors and expires a peer exactly ten seconds after its last heartbeat", () => {
    const { client, doc, awareness, send, message } = setup();
    client.connect();
    client.setSelection({}, doc, 1, 1);
    client.receive(message);
    vi.advanceTimersByTime(3_000);
    expect(send).toHaveBeenCalledTimes(2);
    client.receive(message);
    vi.advanceTimersByTime(9_999);
    expect(awareness.getStates().has(123)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(awareness.getStates().has(123)).toBe(false);
  });

  it("clears peers on disconnection and republishes the active selection on reconnection", () => {
    const { client, doc, awareness, send, message } = setup();
    client.connect();
    client.setSelection({}, doc, 2, 2);
    client.receive(message);
    client.disconnect();
    expect(awareness.getStates().size).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(send).toHaveBeenCalledTimes(1);
    client.connect();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("replaces a device's previous document and client ID without touching the local ID", () => {
    const { client, doc, awareness, message } = setup();
    client.receive(message);
    client.receive({ ...message, clientId: 456 });
    expect([...awareness.getStates().keys()]).toEqual([456]);
    client.receive({ ...message, clientId: doc.clientID });
    expect(awareness.getLocalState()).toBeNull();
    expect(awareness.getStates().size).toBe(0);
    client.receive(message);
    client.receive({ ...message, fileId: "other" });
    expect(awareness.getStates().size).toBe(0);
  });

  it("retains relative positions when text is inserted before a remote selection", () => {
    const { client, doc, awareness, message } = setup();
    client.receive(message);
    doc.getText("content").insert(0, "追記");
    const position = Y.createAbsolutePositionFromRelativePosition(
      awareness.getStates().get(123)!["cursor"].head,
      doc,
    );
    expect(position?.index).toBe(5);
  });

  it("hydrates a newly opened editor and clears a removed document", () => {
    const { client, doc, message, send } = setup();
    client.forgetDoc(doc);
    client.receive(message);
    const awareness = client.getAwareness("note", doc);
    expect(awareness.getStates().get(123)?.["user"].name).toBe("iPhone");
    client.connect();
    client.setSelection({}, doc, 0, 0);
    client.forgetDoc(doc);
    expect(send.mock.lastCall![0].cursor).toBeNull();
  });
  it("keeps the awareness instance when a document is remapped and publishes the new file ID", () => {
    const { client, doc, awareness, message, send } = setup();
    client.connect();
    client.setSelection({}, doc, 1, 2);
    client.receive(message);
    client.receive({ ...message, deviceId: "second-peer", clientId: 456, fileId: "new-note" });
    client.remapDoc(doc, "new-note");
    expect(client.getAwareness("new-note", doc)).toBe(awareness);
    expect([...awareness.getStates().keys()]).toEqual([456]);
    expect(send.mock.lastCall![0]).toMatchObject({
      fileId: "new-note",
      cursor: expect.any(Object),
    });
    client.setName("MacBook");
    expect(send.mock.lastCall![0].name).toBe("MacBook");
    vi.advanceTimersByTime(3_000);
    expect(send.mock.lastCall![0]).toMatchObject({ fileId: "new-note", name: "MacBook" });
  });
});
