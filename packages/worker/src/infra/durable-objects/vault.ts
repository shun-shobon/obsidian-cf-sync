import { idSchema, type BlobRef, type OperationResult } from "@cf-sync/protocol";
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import { ApplicationError } from "../../domain/errors";
import type { VaultMeta } from "../../domain/vault-state";
import { ApplyOperation } from "../../usecase/apply-operation";
import { FlushVault } from "../../usecase/flush-vault";
import { BlobStorage } from "../blob-storage";
import type { Env } from "../env";
import { errorResponse } from "../http/responses";
import { R2VaultArchive } from "../r2-vault-archive";
import { jsonStream, readOperation } from "../rpc-json";
import { rpcResult, type RpcResult } from "../rpc-result";
import { VaultMaintenance } from "../vault-maintenance";
import { VaultRepository } from "../vault-repository";
import { VaultSockets } from "../vault-sockets";

export class Vault extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly repository: VaultRepository;
  private readonly sockets: VaultSockets;
  private readonly flush: FlushVault;
  private readonly maintenance: VaultMaintenance;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    this.repository = new VaultRepository(state.storage);
    this.sockets = new VaultSockets(state);
    this.maintenance = new VaultMaintenance(state.storage);
    this.flush = new FlushVault(
      this.repository,
      this.sockets,
      new R2VaultArchive(env.BUCKET),
      this.maintenance,
    );
  }

  snapshot(vaultId: string, deviceId: string): Promise<RpcResult<ReadableStream<Uint8Array>>> {
    return this.execute(vaultId, deviceId, (meta) => this.readSnapshot(meta));
  }

  applyOperation(
    vaultId: string,
    deviceId: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<RpcResult<OperationResult>> {
    return this.execute(vaultId, deviceId, async () => {
      const operation = await readOperation(stream);
      const blobs = new BlobStorage(this.env.BUCKET, vaultId);
      const operations = new ApplyOperation(this.repository, this.sockets, blobs);

      const result = await operations.execute(operation);
      console.info({
        event: "sync.operation.completed",
        vaultId,
        deviceId,
        operationId: operation.opId,
        operationType: operation.type,
        revision: result.revision,
        conflict: result.conflict,
      });

      return result;
    });
  }

  document(
    vaultId: string,
    deviceId: string,
    fileId: string,
  ): Promise<RpcResult<ReadableStream<Uint8Array>>> {
    return this.execute(vaultId, deviceId, async () => {
      const stored = await this.repository.file(fileId);
      const content = await this.repository.content(stored);

      return jsonStream({ file: stored.file, content });
    });
  }

  setExclusions(
    vaultId: string,
    deviceId: string,
    exclusions: string[],
  ): Promise<RpcResult<ReadableStream<Uint8Array>>> {
    return this.execute(vaultId, deviceId, async (meta) => {
      await this.repository.setExclusions(meta, exclusions);
      await this.maintenance.schedule();
      this.sockets.broadcast({ type: "settings", revision: meta.revision });

      return this.readSnapshot(meta);
    });
  }

  issueTicket(
    vaultId: string,
    deviceId: string,
  ): Promise<RpcResult<{ ticket: string; expiresAt: number }>> {
    return this.execute(vaultId, deviceId, async () => {
      const ticket = await this.sockets.issueTicket(deviceId);
      await this.maintenance.schedule();

      return ticket;
    });
  }

  downloadBlob(
    vaultId: string,
    deviceId: string,
    key: string,
  ): Promise<RpcResult<ReadableStream<Uint8Array>>> {
    return this.execute(vaultId, deviceId, async () => {
      const blobs = new BlobStorage(this.env.BUCKET, vaultId);
      const object = await blobs.get(key);

      return object.body;
    });
  }

  uploadBlob(
    vaultId: string,
    deviceId: string,
    key: string,
    digest: string,
    body: ReadableStream<Uint8Array> | null,
    sizeHeader: string | null,
  ): Promise<RpcResult<BlobRef>> {
    return this.execute(vaultId, deviceId, async () => {
      const blobs = new BlobStorage(this.env.BUCKET, vaultId);
      await this.maintenance.request("blobs");
      const blob = await blobs.upload(key, digest, body, sizeHeader);
      await this.maintenance.schedule();

      return blob;
    });
  }

  revokeDevice(deviceId: string): Promise<RpcResult<void>> {
    return this.serial(() => rpcResult(() => this.sockets.revoke(deviceId)));
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      return await this.serial(async () => {
        const path = new URL(request.url).pathname;

        if (request.method !== "GET" || path !== "/ws") {
          throw new ApplicationError("not-found", "Not found");
        }

        const vaultId = v.parse(idSchema, request.headers.get("X-Vault-Id"));
        await this.repository.initialize(vaultId);

        try {
          return await this.sockets.connect(request);
        } finally {
          await this.maintenance.schedule();
        }
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  override alarm(): Promise<void> {
    return this.serial(() => this.flush.execute());
  }

  override async webSocketMessage(ws: WebSocket): Promise<void> {
    ws.close(1008, "Use authenticated HTTP for operations");
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code);
    console.info({ event: "websocket.closed", code });
  }

  private execute<T>(
    vaultId: string,
    deviceId: string,
    action: (meta: VaultMeta) => Promise<T>,
  ): Promise<RpcResult<T>> {
    return this.serial(() =>
      rpcResult(async () => {
        const meta = await this.repository.initialize(vaultId);
        await this.sockets.assertDeviceActive(deviceId);

        return action(meta);
      }),
    );
  }

  private async readSnapshot(meta: VaultMeta): Promise<ReadableStream<Uint8Array>> {
    const stored = await this.repository.files();
    const files = stored.map((item) => item.file);

    return jsonStream({ ...meta, files });
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);

    return next;
  }
}
