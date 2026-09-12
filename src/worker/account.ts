import { z } from "zod";

import { idSchema, type Device, type VaultInfo } from "../shared/protocol";

import { handleErrors, HttpError, json, type Env } from "./env";
const named = z.object({ id: idSchema, name: z.string().trim().min(1).max(200) });
export class Account {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}
  async fetch(request: Request): Promise<Response> {
    return handleErrors(async () => {
      const url = new URL(request.url);
      if (url.pathname === "/devices" && request.method === "POST") {
        const input = named.parse(await request.json());
        const result = await this.state.storage.transaction(async (tx) => {
          const previous = await tx.get<Device>(`device:${input.id}`);
          if (previous?.revoked) throw new HttpError(403, "Device revoked");
          const device: Device = { ...input, revoked: false };
          await tx.put(`device:${input.id}`, device);
          return device;
        });
        return json(result);
      }
      if (url.pathname === "/devices" && request.method === "GET")
        return json([...(await this.state.storage.list<Device>({ prefix: "device:" })).values()]);
      const deviceMatch = /^\/devices\/([^/]+)$/.exec(url.pathname);
      if (deviceMatch) {
        const id = idSchema.parse(deviceMatch[1]);
        const device = await this.state.storage.get<Device>(`device:${id}`);
        if (!device) throw new HttpError(404, "Unknown device");
        if (request.method === "GET") {
          if (device.revoked) throw new HttpError(403, "Device revoked");
          return json(device);
        }
        if (request.method === "DELETE") {
          await this.state.storage.put(`device:${id}`, { ...device, revoked: true });
          const vaults = await this.state.storage.list<VaultInfo>({ prefix: "vault:" });
          await Promise.all(
            [...vaults.values()].map(async (vault) => {
              const response = await this.env.VAULTS.get(
                this.env.VAULTS.idFromName(vault.id),
              ).fetch("https://internal/revoke", {
                method: "POST",
                body: JSON.stringify({ deviceId: id }),
              });
              if (!response.ok) throw new Error("Could not revoke vault connections");
            }),
          );
          return json({ ok: true });
        }
      }
      if (url.pathname === "/vaults" && request.method === "GET")
        return json([...(await this.state.storage.list<VaultInfo>({ prefix: "vault:" })).values()]);
      if (url.pathname === "/vaults" && request.method === "POST") {
        const vault = named.parse(await request.json());
        await this.state.storage.put(`vault:${vault.id}`, vault);
        return json(vault);
      }
      const vaultMatch = /^\/vaults\/([^/]+)$/.exec(url.pathname);
      if (vaultMatch && request.method === "GET") {
        const vault = await this.state.storage.get<VaultInfo>(
          `vault:${idSchema.parse(vaultMatch[1])}`,
        );
        if (!vault) throw new HttpError(404, "Unknown vault");
        return json(vault);
      }
      throw new HttpError(404, "Not found");
    });
  }
}
