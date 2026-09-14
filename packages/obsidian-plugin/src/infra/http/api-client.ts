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
import { ConnectionError } from "@cf-sync/sync-core/domain/connection-error";
import { DocumentNotFoundError } from "@cf-sync/sync-core/domain/document-not-found-error";
import type { ApiPort, SyncSocket } from "@cf-sync/sync-core/sync/ports/api-port";
import * as v from "valibot";

import { ApiError } from "../../domain/api-error";
import { AuthenticationError } from "../../domain/authentication-error";
import { urlSchema } from "../../domain/url-schema";
import { t } from "../../i18n";
import { OAuthClient } from "../auth/oauth-client";

import type { HttpRequest, Transport } from "./transport";
import { connectSocket } from "./websocket";

const connectionTicketSchema = v.object({
  url: urlSchema,
  expiresAt: v.pipe(v.number(), v.finite()),
});

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
    let serializedBody: string | undefined;

    if (body !== undefined) {
      serializedBody = JSON.stringify(body);
    }

    const headers = { "Content-Type": "application/json" };
    const response = await this.send(path, method, serializedBody, headers);

    return JSON.parse(response.text) as unknown;
  }

  private async send(
    path: string,
    method: string,
    body?: string | ArrayBuffer,
    headers: Record<string, string> = {},
  ) {
    const token = await this.auth.token();
    const request: HttpRequest = {
      url: this.auth.origin + path,
      method,
      headers: {
        ...headers,
        Authorization: `Bearer ${token}`,
        "X-Device-Id": this.deviceId,
      },
    };

    if (body !== undefined) {
      request.body = body;
    }

    const response = await this.transport(request).catch((cause: unknown) => {
      throw new ConnectionError(
        t(($) => $.errors.serverUnavailable),
        { cause },
      );
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(t(($) => $.errors.accessDenied));
    }

    if (response.status < 200 || response.status >= 300) {
      if (response.status >= 500 || response.status === 429) {
        throw new ConnectionError(t(($) => $.errors.apiFailed, { status: response.status }));
      }

      throw new ApiError(response.status);
    }

    return response;
  }

  async snapshot() {
    const response = await this.request(this.vaultPath("/snapshot"));

    return v.parse(snapshotSchema, response);
  }

  async document(id: string) {
    const response = await this.request(this.vaultPath(`/files/${id}`)).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) {
        throw new DocumentNotFoundError(t(($) => $.errors.documentDeleted));
      }

      throw error;
    });

    return v.parse(documentSchema, response);
  }

  async operate(op: Operation) {
    const response = await this.request(this.vaultPath("/operations"), "POST", op);

    return v.parse(operationResultSchema, response);
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

    return v.parse(blobSchema, JSON.parse(response.text));
  }

  async download(ref: BlobRef) {
    const response = await this.send(this.vaultPath(`/blobs/${ref.key}`), "GET");

    return new Uint8Array(response.bytes);
  }

  async devices() {
    const response = await this.request("/api/devices");

    return v.parse(v.array(deviceSchema), response);
  }

  async registerDevice(name: string) {
    const response = await this.request("/api/devices", "POST", { id: this.deviceId, name });

    return v.parse(deviceSchema, response);
  }

  async revokeDevice(id: string) {
    await this.request(`/api/devices/${id}`, "DELETE");
  }

  async vaults() {
    const response = await this.request("/api/vaults");

    return v.parse(v.array(vaultInfoSchema), response);
  }

  async createVault(name: string) {
    const response = await this.request("/api/vaults", "POST", { id: crypto.randomUUID(), name });

    return v.parse(vaultInfoSchema, response);
  }

  async exclusions(exclusions: string[]) {
    const response = await this.request(this.vaultPath("/exclusions"), "PUT", { exclusions });

    return v.parse(snapshotSchema, response);
  }

  async connect(
    onMessage: (message: ServerMessage) => void,
    onClose: () => void,
  ): Promise<SyncSocket> {
    const response = await this.request(this.vaultPath("/tickets"), "POST");
    const ticket = v.parse(connectionTicketSchema, response);

    return connectSocket(ticket, this.auth.origin, onMessage, onClose);
  }
}
