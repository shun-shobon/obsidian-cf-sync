import {
  blobSchema,
  deviceSchema,
  documentSchema,
  operationResultSchema,
  snapshotSchema,
  vaultInfoSchema,
  type BlobRef,
  type Operation,
} from "@cf-sync/protocol";
import { DocumentNotFoundError, type RestApiPort } from "@cf-sync/sync-core";
import * as v from "valibot";

import type { Credentials } from "../../domain/credentials";

export class RestApi implements RestApiPort {
  constructor(
    private readonly origin: string,
    private readonly credentials: Credentials,
    private readonly deviceId: string,
    private readonly vaultId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private path(suffix: string): string {
    return `/api/vaults/${encodeURIComponent(this.vaultId)}${suffix}`;
  }

  private async send(
    path: string,
    method = "GET",
    body?: BodyInit,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const response = await this.fetcher(this.origin + path, {
      method,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "CF-Access-Client-Id": this.credentials.clientId,
        "CF-Access-Client-Secret": this.credentials.clientSecret,
        "X-Device-Id": this.deviceId,
        ...headers,
      },
    });

    if (!response.ok) {
      if (response.status === 404 && path.startsWith(this.path("/files/"))) {
        throw new DocumentNotFoundError("Remote document no longer exists");
      }

      throw new Error(`API request failed: HTTP ${response.status}`);
    }

    return response;
  }

  private async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let serialized: string | undefined;

    if (body !== undefined) {
      serialized = JSON.stringify(body);
    }

    const response = await this.send(path, method, serialized, {
      "Content-Type": "application/json",
    });

    return response.json();
  }

  async snapshot() {
    return v.parse(snapshotSchema, await this.request(this.path("/snapshot")));
  }

  async document(id: string) {
    return v.parse(
      documentSchema,
      await this.request(this.path(`/files/${encodeURIComponent(id)}`)),
    );
  }

  async operate(operation: Operation) {
    return v.parse(
      operationResultSchema,
      await this.request(this.path("/operations"), "POST", operation),
    );
  }

  async upload(key: string, bytes: Uint8Array, digest: string) {
    const response = await this.send(
      this.path(`/blobs/${encodeURIComponent(key)}`),
      "PUT",
      new Uint8Array(bytes),
      {
        "Content-Type": "application/octet-stream",
        "X-Content-Digest": digest,
        "X-Content-Size": String(bytes.byteLength),
      },
    );

    return v.parse(blobSchema, await response.json());
  }

  async download(ref: BlobRef) {
    const response = await this.send(this.path(`/blobs/${encodeURIComponent(ref.key)}`));
    const bytes = await response.arrayBuffer();

    return new Uint8Array(bytes);
  }

  async vaults() {
    return v.parse(v.array(vaultInfoSchema), await this.request("/api/vaults"));
  }

  async registerDevice(name: string) {
    return v.parse(
      deviceSchema,
      await this.request("/api/devices", "POST", { id: this.deviceId, name }),
    );
  }
}
