import {
  blobSchema,
  deviceSchema,
  documentSchema,
  operationResultSchema,
  snapshotSchema,
  vaultInfoSchema,
  type BlobRef,
  type Operation,
  type ServerMessage,
} from "@cf-sync/protocol";
import { z } from "zod";

import { AuthenticationError } from "../../domain/authentication-error";
import type { ApiPort } from "../../sync/ports/api-port";
import { OAuthClient } from "../auth/oauth-client";

import type { Transport } from "./transport";
import { connectSocket } from "./websocket";

export class ApiClient implements ApiPort {
  constructor(
    private readonly auth: OAuthClient,
    private readonly transport: Transport,
    private readonly deviceId: string,
    private readonly vaultId: string,
  ) {}

  private vaultPath(path: string): string {
    return `/api/vaults/${this.vaultId}${path}`;
  }

  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.send(
      path,
      method,
      body === undefined ? undefined : JSON.stringify(body),
      { "Content-Type": "application/json" },
    );
    return JSON.parse(response.text) as unknown;
  }

  private async send(
    path: string,
    method: string,
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {},
  ) {
    const token = await this.auth.token();
    const response = await this.transport({
      url: this.auth.origin + path,
      method,
      headers: { ...headers, Authorization: `Bearer ${token}`, "X-Device-Id": this.deviceId },
      ...(body === undefined ? {} : { body }),
    });
    if (response.status === 401 || response.status === 403)
      throw new AuthenticationError("認証または端末の許可を確認してください");
    if (response.status < 200 || response.status >= 300)
      throw new Error(`同期 API エラー (${response.status})`);
    return response;
  }

  async snapshot() {
    return snapshotSchema.parse(await this.request(this.vaultPath("/snapshot")));
  }

  async document(id: string) {
    return documentSchema.parse(await this.request(this.vaultPath(`/files/${id}`)));
  }

  async operate(op: Operation) {
    return operationResultSchema.parse(
      await this.request(this.vaultPath("/operations"), "POST", op),
    );
  }

  async upload(key: string, bytes: Uint8Array, digest: string) {
    const response = await this.send(
      this.vaultPath(`/blobs/${key}`),
      "PUT",
      new Uint8Array(bytes).buffer,
      {
        "Content-Type": "application/octet-stream",
        "X-Content-Digest": digest,
        "X-Content-Size": String(bytes.byteLength),
      },
    );
    return blobSchema.parse(JSON.parse(response.text));
  }

  async download(ref: BlobRef) {
    return new Uint8Array((await this.send(this.vaultPath(`/blobs/${ref.key}`), "GET")).bytes);
  }

  async devices() {
    return z.array(deviceSchema).parse(await this.request("/api/devices"));
  }

  async registerDevice(name: string) {
    return deviceSchema.parse(
      await this.request("/api/devices", "POST", { id: this.deviceId, name }),
    );
  }

  async revokeDevice(id: string) {
    await this.request(`/api/devices/${id}`, "DELETE");
  }

  async vaults() {
    return z.array(vaultInfoSchema).parse(await this.request("/api/vaults"));
  }

  async createVault(name: string) {
    return vaultInfoSchema.parse(
      await this.request("/api/vaults", "POST", { id: crypto.randomUUID(), name }),
    );
  }

  async exclusions(exclusions: string[]) {
    return snapshotSchema.parse(
      await this.request(this.vaultPath("/exclusions"), "PUT", { exclusions }),
    );
  }

  async connect(
    onMessage: (message: ServerMessage) => void,
    onClose: () => void,
  ): Promise<{ close(): void }> {
    const ticket = z
      .object({ url: z.string().url(), expiresAt: z.number() })
      .parse(await this.request(this.vaultPath("/tickets"), "POST"));
    return connectSocket(ticket, this.auth.origin, onMessage, onClose);
  }
}
