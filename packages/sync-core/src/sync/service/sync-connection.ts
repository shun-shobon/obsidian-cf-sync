import type { ClientMessage, Operation, OperationResult, ServerMessage } from "@cf-sync/protocol";

import { ConnectionError } from "../../domain/connection-error";
import { t } from "../../i18n";
import type { ApiPort, SyncSocket } from "../ports/api-port";

interface PendingOperation {
	resolve(result: OperationResult): void;
	reject(error: unknown): void;
	timer: ReturnType<typeof setTimeout>;
}

export class SyncConnection {
	private socket: SyncSocket | undefined;
	private readonly pending = new Map<string, PendingOperation>();
	generation = 0;

	constructor(
		private readonly api: ApiPort,
		private readonly onMessage: (message: ServerMessage) => void,
		private readonly onClose: (error: Error) => void,
	) {}

	get connected(): boolean {
		return this.socket !== undefined;
	}

	send(message: ClientMessage): void {
		if (!this.socket) {
			throw new ConnectionError(t(($) => $.errors.websocketDisconnected));
		}
		this.socket.send(message);
	}

	operate(operation: Operation): Promise<OperationResult> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(operation.opId);
				reject(new ConnectionError(t(($) => $.errors.websocketTimeout)));
			}, 15_000);
			this.pending.set(operation.opId, { resolve, reject, timer });
			try {
				this.send({ type: "operation", operation });
			} catch (error) {
				this.settle(operation.opId);
				throw error;
			}
		});
	}

	disconnect(): void {
		this.generation += 1;
		const socket = this.socket;
		this.socket = undefined;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new ConnectionError(t(($) => $.errors.websocketDisconnected)));
		}
		this.pending.clear();
		socket?.close();
	}

	async connect(): Promise<void> {
		if (this.socket) {
			return;
		}

		const generation = this.generation;
		// connect中にonCloseが呼ばれても、awaitを跨いだ後のTSの絞り込みでfalse固定にならないようオブジェクトで持つ
		const connectState = { closed: false };
		const socket = await this.api.connect(
			(message) => {
				if (generation !== this.generation) {
					return;
				}
				if (message.type === "operation-error") {
					this.settle(message.opId)?.reject(operationError(message));
					return;
				}
				if (message.type === "operation-result") {
					this.settle(message.result.opId)?.resolve(message.result);
					return;
				}
				this.onMessage(message);
			},
			(error) => {
				connectState.closed = true;
				if (generation === this.generation) {
					this.onClose(error);
				}
			},
		);
		if (connectState.closed || generation !== this.generation) {
			socket.close();
			return;
		}

		this.socket = socket;
	}

	private settle(opId: string): PendingOperation | undefined {
		const pending = this.pending.get(opId);
		if (pending) {
			clearTimeout(pending.timer);
			this.pending.delete(opId);
		}

		return pending;
	}
}

function operationError(message: Extract<ServerMessage, { type: "operation-error" }>): Error {
	if (message.retryable) {
		return new ConnectionError(message.message);
	}

	return new Error(message.message);
}
