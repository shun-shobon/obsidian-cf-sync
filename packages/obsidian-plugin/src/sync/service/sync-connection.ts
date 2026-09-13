import type { ClientMessage, Operation, OperationResult, ServerMessage } from "@cf-sync/protocol";

import { ConnectionError } from "../../domain/connection-error";
import { t } from "../../i18n";
import type { ApiPort, SyncSocket } from "../ports/api-port";

export class SyncConnection {
  private socket: SyncSocket | undefined;
  private readonly pending = new Map<
    string,
    {
      resolve(result: OperationResult): void;
      reject(error: unknown): void;
      timer: number;
    }
  >();
  generation = 0;

  constructor(
    private readonly api: ApiPort,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onClose: () => void,
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
      const timer = window.setTimeout(() => {
        this.pending.delete(operation.opId);
        reject(new ConnectionError(t(($) => $.errors.websocketTimeout)));
      }, 15_000);
      this.pending.set(operation.opId, { resolve, reject, timer });
      try {
        this.send({ type: "operation", operation });
      } catch (error) {
        window.clearTimeout(timer);
        this.pending.delete(operation.opId);
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.generation += 1;
    const socket = this.socket;
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
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
    let closed = false;
    const socket = await this.api.connect(
      (message) => {
        if (generation !== this.generation) {
          return;
        }
        if (message.type === "operation-error") {
          const pending = this.pending.get(message.opId);
          if (pending) {
            window.clearTimeout(pending.timer);
            this.pending.delete(message.opId);
            let error: Error = new Error(message.message);
            if (message.retryable) {
              error = new ConnectionError(message.message);
            }
            pending.reject(error);
          }
          return;
        }
        if (message.type === "operation-result") {
          const pending = this.pending.get(message.result.opId);
          if (pending) {
            window.clearTimeout(pending.timer);
            this.pending.delete(message.result.opId);
            pending.resolve(message.result);
          }
          return;
        }
        this.onMessage(message);
      },
      () => {
        closed = true;
        if (generation === this.generation) {
          this.onClose();
        }
      },
    );
    if (closed || generation !== this.generation) {
      socket.close();
      return;
    }

    this.socket = socket;
  }
}
