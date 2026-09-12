import type { ServerMessage } from "@cf-sync/protocol";

import type { ApiPort } from "../ports/api-port";

export class SyncConnection {
  private socket: { close(): void } | undefined;
  generation = 0;

  constructor(
    private readonly api: ApiPort,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onClose: () => void,
  ) {}

  disconnect(): void {
    this.generation += 1;
    const socket = this.socket;
    this.socket = undefined;
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
        if (generation === this.generation) {
          this.onMessage(message);
        }
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
