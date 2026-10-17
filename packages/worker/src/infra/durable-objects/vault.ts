import { clientMessageSchema, idSchema } from "@cf-sync/protocol";
import type { BlobRef, Operation, OperationResult, Snapshot } from "@cf-sync/protocol";
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";

import { ApplicationError } from "../../domain/errors";
import type { VaultMeta } from "../../domain/vault-state";
import { applyOperation } from "../../usecase/apply-operation";
import { FlushVault } from "../../usecase/flush-vault";
import { BlobStorage } from "../blob-storage";
import type { Env } from "../env";
import { errorResponse } from "../http/responses";
import { R2VaultArchive } from "../r2-vault-archive";
import { jsonStream, readOperation } from "../rpc-json";
import { rpcResult } from "../rpc-result";
import type { RpcResult } from "../rpc-result";
import { VaultMaintenance } from "../vault-maintenance";
import { VaultRepository } from "../vault-repository";
import { VaultSockets } from "../vault-sockets";

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class Vault extends DurableObject<Env> {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly repository: VaultRepository;
	private readonly sockets: VaultSockets;
	private readonly flush: FlushVault;
	private readonly maintenance: VaultMaintenance;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);

		this.sockets = new VaultSockets(state);
		this.maintenance = new VaultMaintenance(state.storage, this.sockets);
		this.repository = new VaultRepository(state.storage, this.maintenance);
		this.flush = new FlushVault(
			this.repository,
			this.sockets,
			new R2VaultArchive(env.BUCKET),
			this.maintenance,
			(action) => this.serial(action),
		);
	}

	snapshot(vaultId: string, deviceId: string): Promise<RpcResult<ReadableStream<Uint8Array>>> {
		return rpcResult(() => this.run(vaultId, deviceId, (meta) => this.readSnapshot(meta)));
	}

	applyOperation(
		vaultId: string,
		deviceId: string,
		stream: ReadableStream<Uint8Array> | null,
	): Promise<RpcResult<OperationResult>> {
		return rpcResult(async () => {
			const operation = await readOperation(stream);

			return await this.run(vaultId, deviceId, (meta) => this.apply(meta, operation, deviceId));
		});
	}

	document(
		vaultId: string,
		deviceId: string,
		fileId: string,
	): Promise<RpcResult<ReadableStream<Uint8Array>>> {
		return rpcResult(() =>
			this.run(vaultId, deviceId, async () => {
				const stored = await this.repository.file(fileId);
				const content = await this.repository.content(stored);

				return jsonStream({ file: stored.file, content });
			}),
		);
	}

	setExclusions(
		vaultId: string,
		deviceId: string,
		exclusions: string[],
	): Promise<RpcResult<ReadableStream<Uint8Array>>> {
		return rpcResult(() =>
			this.run(vaultId, deviceId, async (meta) => {
				await this.repository.setExclusions(meta, exclusions);
				await this.maintenance.schedule();
				this.sockets.broadcast({ type: "settings", revision: meta.revision });

				return await this.readSnapshot(meta);
			}),
		);
	}

	issueTicket(
		vaultId: string,
		deviceId: string,
	): Promise<RpcResult<{ ticket: string; expiresAt: number }>> {
		return rpcResult(() =>
			this.run(vaultId, deviceId, async () => {
				const ticket = await this.sockets.issueTicket(deviceId);
				await this.maintenance.schedule();

				return ticket;
			}),
		);
	}

	downloadBlob(
		vaultId: string,
		deviceId: string,
		key: string,
	): Promise<RpcResult<ReadableStream<Uint8Array>>> {
		return rpcResult(async () => {
			await this.serial(() => this.authorize(vaultId, deviceId));
			const object = await new BlobStorage(this.env.BUCKET, vaultId).get(key);

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
		return rpcResult(async () => {
			await this.serial(() => this.authorize(vaultId, deviceId));
			const blob = await new BlobStorage(this.env.BUCKET, vaultId).upload(
				key,
				digest,
				body,
				sizeHeader,
			);
			await this.serial(() => this.maintenance.request("blobs"));

			return blob;
		});
	}

	revokeDevice(deviceId: string): Promise<RpcResult<void>> {
		return rpcResult(() => this.serial(() => this.sockets.revoke(deviceId)));
	}

	override async fetch(request: Request): Promise<Response> {
		try {
			return await this.serial(async () => {
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
		return this.flush.execute();
	}

	override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
		try {
			if (
				typeof data !== "string" ||
				new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES
			) {
				this.sockets.disconnect(ws, 1009, "Invalid message size");
				return;
			}

			const message = v.parse(clientMessageSchema, JSON.parse(data));

			if (message.type === "presence") {
				const deviceId = await this.sockets.authenticate(ws);
				this.sockets.presence(ws, deviceId, message);
				return;
			}

			await this.serial(() => this.applySocketOperation(ws, message.operation));
		} catch (error) {
			console.error(error);
			this.sockets.disconnect(ws, 1008, "Invalid or rejected sync message");
		}
	}

	override webSocketClose(ws: WebSocket, code: number): void {
		this.sockets.leave(ws);
		console.info({ event: "websocket.closed", code });
	}

	override webSocketError(ws: WebSocket): void {
		this.sockets.leave(ws);
		console.warn({ event: "websocket.error" });
	}

	private async run<T>(
		vaultId: string,
		deviceId: string,
		action: (meta: VaultMeta) => Promise<T>,
	): Promise<T> {
		return await this.serial(async () => {
			const meta = await this.authorize(vaultId, deviceId);

			return await action(meta);
		});
	}

	private async authorize(vaultId: string, deviceId: string): Promise<VaultMeta> {
		const meta = await this.repository.initialize(vaultId);
		await this.sockets.assertDeviceActive(deviceId);

		return meta;
	}

	private async applySocketOperation(ws: WebSocket, operation: Operation): Promise<void> {
		const deviceId = await this.sockets.authenticate(ws);
		const meta = await this.repository.meta();

		try {
			const result = await this.apply(meta, operation, deviceId);
			ws.send(JSON.stringify({ type: "operation-result", result }));
		} catch (error) {
			const applicationError = error instanceof ApplicationError;
			let errorMessage = "Operation persistence failed";

			if (applicationError) {
				errorMessage = error.message;
			}

			ws.send(
				JSON.stringify({
					type: "operation-error",
					opId: operation.opId,
					message: errorMessage,
					retryable: !applicationError,
				}),
			);
		}
	}

	private async apply(
		meta: VaultMeta,
		operation: Operation,
		deviceId: string,
	): Promise<OperationResult> {
		const context = {
			repository: this.repository,
			sockets: this.sockets,
			blobs: new BlobStorage(this.env.BUCKET, meta.vaultId),
		};
		const result = await applyOperation(context, meta, operation, deviceId);

		console.info({
			event: "sync.operation.completed",
			vaultId: meta.vaultId,
			deviceId,
			operationId: operation.opId,
			operationType: operation.type,
			revision: result.revision,
			conflict: result.conflict,
		});

		return result;
	}

	private async readSnapshot(meta: VaultMeta): Promise<ReadableStream<Uint8Array>> {
		const stored = await this.repository.files();
		const snapshot: Snapshot = {
			revision: meta.revision,
			r2Revision: meta.r2Revision,
			files: stored.map((item) => item.file),
			exclusions: meta.exclusions,
		};

		return jsonStream(snapshot);
	}

	private serial<T>(action: () => Promise<T>): Promise<T> {
		const next = this.tail.then(action);
		this.tail = next.catch(() => undefined);

		return next;
	}
}
