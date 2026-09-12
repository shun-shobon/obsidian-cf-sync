import { idSchema } from "@cf-sync/protocol";
import { z } from "zod";

import { ApplicationError } from "../../domain/errors";
import { revokeDevice } from "../../usecase/revoke-device";
import { AccountRepository } from "../account-repository";
import { DurableObjectDeviceConnections } from "../device-connections";
import type { Env } from "../env";
import { handleErrors, json } from "../http/responses";

const named = z.object({ id: idSchema, name: z.string().trim().min(1).max(200) });

export class Account {
  private readonly repository: AccountRepository;

  constructor(
    state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.repository = new AccountRepository(state.storage);
  }

  fetch(request: Request): Promise<Response> {
    return handleErrors(() => this.route(request));
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/devices" && request.method === "POST") {
      return json(await this.repository.registerDevice(named.parse(await request.json())));
    }
    if (path === "/devices" && request.method === "GET")
      return json(await this.repository.devices());
    const device = /^\/devices\/([^/]+)$/.exec(path);
    if (device) return this.device(request, idSchema.parse(device[1]));

    if (path === "/vaults" && request.method === "GET") return json(await this.repository.vaults());
    if (path === "/vaults" && request.method === "POST") {
      const vault = named.parse(await request.json());
      await this.repository.saveVault(vault);
      return json(vault);
    }
    const vault = /^\/vaults\/([^/]+)$/.exec(path);
    if (vault && request.method === "GET")
      return json(await this.repository.vault(idSchema.parse(vault[1])));
    throw new ApplicationError("not-found", "Not found");
  }

  private async device(request: Request, id: string): Promise<Response> {
    const device = await this.repository.device(id);
    if (request.method === "GET") {
      if (device.revoked) throw new ApplicationError("forbidden", "Device revoked");
      return json(device);
    }
    if (request.method === "DELETE") {
      await revokeDevice(
        device,
        this.repository,
        new DurableObjectDeviceConnections(this.env.VAULTS),
      );
      return json({ ok: true });
    }
    throw new ApplicationError("not-found", "Not found");
  }
}
