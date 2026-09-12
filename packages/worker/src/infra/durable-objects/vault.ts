import { FlushVault } from "../../usecase/flush-vault";
import type { Env } from "../env";
import { VaultRoutes } from "../http/vault-routes";
import { R2VaultArchive } from "../r2-vault-archive";
import { VaultRepository } from "../vault-repository";
import { VaultSockets } from "../vault-sockets";

export class Vault {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly repository: VaultRepository;
  private readonly sockets: VaultSockets;
  private readonly flush: FlushVault;
  private readonly routes: VaultRoutes;

  constructor(state: DurableObjectState, env: Env) {
    this.repository = new VaultRepository(state.storage);
    this.sockets = new VaultSockets(state);
    this.flush = new FlushVault(this.repository, this.sockets, new R2VaultArchive(env.BUCKET));
    this.routes = new VaultRoutes(this.repository, this.sockets, env.BUCKET);
  }

  fetch(request: Request): Promise<Response> {
    return this.serial(async () => this.routes.app.fetch(request));
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

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
