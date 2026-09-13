import type { ClientMessage, ServerMessage } from "@cf-sync/protocol";
import { fromUint8Array, toUint8Array } from "js-base64";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

type OutgoingPresence = Extract<ClientMessage, { type: "presence" }>;
type IncomingPresence = Extract<ServerMessage, { type: "presence" }>;
type RemotePresence = { message: IncomingPresence; expiry: ReturnType<typeof setTimeout> };

export class Presence {
  private readonly documents = new Map<Y.Doc, { fileId: string; awareness: Awareness }>();
  private readonly remote = new Map<string, RemotePresence>();
  private active?: { owner: object; doc: Y.Doc; message: OutgoingPresence };
  private connected = false;
  private lastSent = -Infinity;
  private pending?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      deviceId: string;
      name: string;
      send: (message: OutgoingPresence) => void;
    },
  ) {}

  getAwareness(fileId: string, doc: Y.Doc): Awareness {
    const existing = this.documents.get(doc);
    if (existing) {
      return existing.awareness;
    }
    const awareness = new Awareness(doc);
    // The focused editor publishes selection explicitly. Disable y-codemirror's
    // automatic local updates so inactive panes cannot overwrite that selection.
    awareness.setLocalState(null);
    this.documents.set(doc, { fileId, awareness });
    for (const { message } of this.remote.values()) {
      this.apply(awareness, fileId, message);
    }
    doc.on("destroy", () => {
      this.documents.delete(doc);
      if (this.active?.doc === doc) {
        this.clearSelection(this.active.owner);
      }
    });
    return awareness;
  }

  remapDoc(doc: Y.Doc, fileId: string) {
    const entry = this.documents.get(doc);
    if (!entry || entry.fileId === fileId) {
      return;
    }
    removeAwarenessStates(entry.awareness, [...entry.awareness.getStates().keys()], "remote");
    entry.fileId = fileId;
    for (const { message } of this.remote.values()) {
      this.apply(entry.awareness, fileId, message);
    }
    if (this.active?.doc === doc) {
      this.active.message = { ...this.active.message, fileId };
      this.sendActive();
    }
  }

  setName(name: string) {
    this.options.name = name;
    if (this.active) {
      this.active.message = { ...this.active.message, name };
      this.sendActive();
    }
  }

  forgetDoc(doc: Y.Doc) {
    if (this.active?.doc === doc) {
      this.clearSelection(this.active.owner);
    }
    this.documents.get(doc)?.awareness.destroy();
    this.documents.delete(doc);
  }

  setSelection(owner: object, doc: Y.Doc, anchor: number, head: number) {
    const entry = this.documents.get(doc);
    if (!entry) {
      throw new Error("Presence document is not registered");
    }
    const text = doc.getText("content");
    const message: OutgoingPresence = {
      type: "presence",
      fileId: entry.fileId,
      clientId: doc.clientID,
      name: this.options.name,
      cursor: {
        anchor: fromUint8Array(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, anchor)),
        ),
        head: fromUint8Array(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, head)),
        ),
      },
    };
    this.active = { owner, doc, message };
    this.startHeartbeat();
    if (this.pending || !this.connected) {
      return;
    }
    const delay = Math.max(0, 50 - (Date.now() - this.lastSent));
    if (delay === 0) {
      this.sendActive();
    } else {
      this.pending = setTimeout(() => {
        this.pending = undefined;
        this.sendActive();
      }, delay);
    }
  }

  clearSelection(owner: object) {
    if (this.active?.owner !== owner) {
      return;
    }
    if (this.connected) {
      this.options.send({ ...this.active.message, fileId: null, cursor: null });
    }
    this.active = undefined;
    this.stopHeartbeat();
    this.cancelPending();
  }

  connect() {
    this.connected = true;
    this.startHeartbeat();
    this.sendActive();
  }

  disconnect() {
    this.connected = false;
    this.stopHeartbeat();
    this.cancelPending();
    for (const deviceId of this.remote.keys()) {
      this.removeRemote(deviceId);
    }
  }

  receive(message: IncomingPresence) {
    if (message.deviceId === this.options.deviceId) {
      return;
    }
    // Decode before changing visible state. Invalid positions must not partially
    // replace a peer's last valid cursor.
    if (message.cursor) {
      Y.decodeRelativePosition(toUint8Array(message.cursor.anchor));
      Y.decodeRelativePosition(toUint8Array(message.cursor.head));
    }
    const previous = this.remote.get(message.deviceId);
    if (previous) {
      clearTimeout(previous.expiry);
      if (
        previous.message.fileId !== message.fileId ||
        previous.message.clientId !== message.clientId ||
        previous.message.name !== message.name
      ) {
        this.removeRemote(message.deviceId);
      }
    }
    if (!message.cursor || !message.fileId) {
      this.removeRemote(message.deviceId);
      return;
    }
    this.remote.set(message.deviceId, {
      message,
      expiry: setTimeout(() => this.removeRemote(message.deviceId), 10_000),
    });
    for (const { fileId, awareness } of this.documents.values()) {
      this.apply(awareness, fileId, message);
    }
  }

  dispose() {
    if (this.active) {
      this.clearSelection(this.active.owner);
    }
    this.disconnect();
    for (const { awareness } of this.documents.values()) {
      awareness.destroy();
    }
    this.documents.clear();
  }

  private startHeartbeat() {
    if (!this.connected || !this.active || this.heartbeat) {
      return;
    }
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSent >= 50) {
        this.sendActive();
      }
    }, 3_000);
  }

  private stopHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private sendActive() {
    if (!this.connected || !this.active) {
      return;
    }
    this.cancelPending();
    this.options.send(this.active.message);
    this.lastSent = Date.now();
  }

  private cancelPending() {
    clearTimeout(this.pending);
    this.pending = undefined;
  }

  private removeRemote(deviceId: string) {
    const remote = this.remote.get(deviceId);
    if (!remote) {
      return;
    }
    clearTimeout(remote.expiry);
    this.remote.delete(deviceId);
    for (const { fileId, awareness } of this.documents.values()) {
      if (fileId === remote.message.fileId && remote.message.clientId !== awareness.clientID) {
        removeAwarenessStates(awareness, [remote.message.clientId], "remote");
      }
    }
  }

  private apply(awareness: Awareness, fileId: string, message: IncomingPresence) {
    if (message.fileId !== fileId || !message.cursor || message.clientId === awareness.clientID) {
      return;
    }
    const hue =
      message.deviceId.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) %
      360;
    const state = {
      user: {
        name: message.name,
        color: `hsl(${hue}, 70%, 42%)`,
        colorLight: `hsla(${hue}, 70%, 42%, 0.2)`,
      },
      cursor: {
        anchor: Y.decodeRelativePosition(toUint8Array(message.cursor.anchor)),
        head: Y.decodeRelativePosition(toUint8Array(message.cursor.head)),
      },
    };
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, message.clientId);
    encoding.writeVarUint(encoder, (awareness.meta.get(message.clientId)?.clock ?? 0) + 1);
    encoding.writeVarString(encoder, JSON.stringify(state));
    applyAwarenessUpdate(awareness, encoding.toUint8Array(encoder), "remote");
  }
}
