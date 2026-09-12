import { AccountRepository } from "../account-repository";
import { DurableObjectDeviceConnections } from "../device-connections";
import type { Env } from "../env";
import { accountRoutes } from "../http/account-routes";

export class Account {
  private readonly app;

  constructor(state: DurableObjectState, env: Env) {
    this.app = accountRoutes(
      new AccountRepository(state.storage),
      new DurableObjectDeviceConnections(env.VAULTS),
    );
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request);
  }
}
