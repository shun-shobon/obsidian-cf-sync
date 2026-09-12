import type { BlobRef, ServerMessage, Snapshot } from "@cf-sync/protocol";
import type { Miniflare } from "miniflare";

import type { ApiPort } from "../../packages/obsidian-plugin/src/sync/ports/api-port";

import { apply, deviceId, document, request, vaultId } from "./runtime-api";

export function createRuntimeApi(mf: Miniflare): ApiPort {
  return {
    async snapshot() {
      const response = await request(mf, "/snapshot");

      return (await response.json()) as Snapshot;
    },

    async document(id) {
      return document(mf, id);
    },

    async operate(op) {
      return apply(mf, op);
    },

    async upload(key, bytes, hash) {
      const result = await mf.dispatchFetch(`https://test/blobs/${key}`, {
        method: "PUT",
        headers: {
          "X-Vault-Id": vaultId,
          "X-Device-Id": deviceId,
          "X-Content-Digest": hash,
          "X-Content-Size": String(bytes.length),
        },
        body: bytes,
      });
      if (!result.ok) {
        throw new Error(await result.text());
      }
      return (await result.json()) as BlobRef;
    },

    async download(ref) {
      const response = await request(mf, `/blobs/${ref.key}`);
      const bytes = await response.arrayBuffer();

      return new Uint8Array(bytes);
    },

    async connect(onMessage, onClose) {
      const ticketResponse = await request(mf, "/tickets", {});
      const ticket = (await ticketResponse.json()) as { ticket: string };
      const response = await mf.dispatchFetch(`https://test/ws?ticket=${ticket.ticket}`, {
        headers: { "X-Vault-Id": vaultId, Upgrade: "websocket" },
      });
      const socket = response.webSocket!;
      socket.accept();
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          throw new Error("Expected JSON message");
        }
        onMessage(JSON.parse(event.data) as ServerMessage);
      });
      socket.addEventListener("close", onClose);
      return { close: () => socket.close() };
    },
  };
}
