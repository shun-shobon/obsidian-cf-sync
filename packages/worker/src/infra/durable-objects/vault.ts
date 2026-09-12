import { idSchema } from "@cf-sync/protocol";
import { z } from "zod";

import { FlushVault } from "../../usecase/flush-vault";
import type { Env } from "../env";
import { handleErrors, json } from "../http/responses";
import { VaultRoutes } from "../http/vault-routes";
import { R2VaultArchive } from "../r2-vault-archive";
import { VaultRepository } from "../vault-repository";
import { VaultSockets } from "../vault-sockets";

export class Vault {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly repository: VaultRepository;
  private readonly sockets: VaultSockets;
  private readonly flush: FlushVault;

  constructor(
    state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.repository = new VaultRepository(state.storage);
    this.sockets = new VaultSockets(state);
    this.flush = new FlushVault(this.repository, this.sockets, new R2VaultArchive(env.BUCKET));
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(() => handleErrors(() => this.route(request)));
  }

  alarm(): Promise<void> {
    return this.serial(() => this.flush.execute());
  }

  async webSocketMessage(ws: WebSocket): Promise<void> {
    ws.close(1008, "Use authenticated HTTP for operations");
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code);
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/revoke") {
      const { deviceId } = z.object({ deviceId: idSchema }).parse(await request.json());
      await this.sockets.revoke(deviceId);
      return json({ ok: true });
    }

    const vaultId = idSchema.parse(request.headers.get("X-Vault-Id"));
    const meta = await this.repository.initialize(vaultId);
    if (path === "/ws") {
      const response = await this.sockets.connect(request);
      await this.repository.schedule();
      return response;
    }

    const deviceId = idSchema.parse(request.headers.get("X-Device-Id"));
    await this.sockets.assertDeviceActive(deviceId);
    return new VaultRoutes(this.repository, this.sockets, this.env.BUCKET, meta).handle(
      request,
      deviceId,
    );
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
