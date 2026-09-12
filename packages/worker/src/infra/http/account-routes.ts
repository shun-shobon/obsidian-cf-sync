import { idSchema } from "@cf-sync/protocol";
import { Hono } from "hono";
import * as v from "valibot";

import { ApplicationError } from "../../domain/errors";
import type { DeviceConnections } from "../../usecase/ports";
import { revokeDevice } from "../../usecase/revoke-device";
import type { AccountRepository } from "../account-repository";

import { notFound, onError } from "./responses";

const named = v.object({
  id: idSchema,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});

export function accountRoutes(repository: AccountRepository, connections: DeviceConnections) {
  const app = new Hono();
  app.onError(onError);
  app.notFound(notFound);

  app.get("/devices", async (c) => c.json(await repository.devices()));

  app.post("/devices", async (c) => {
    const input = v.parse(named, await c.req.json());
    const device = await repository.registerDevice(input);

    return c.json(device);
  });

  app.get("/devices/:id", async (c) => {
    const id = v.parse(idSchema, c.req.param("id"));
    const device = await repository.device(id);

    if (device.revoked) {
      throw new ApplicationError("forbidden", "Device revoked");
    }

    return c.json(device);
  });

  app.delete("/devices/:id", async (c) => {
    const id = v.parse(idSchema, c.req.param("id"));
    const device = await repository.device(id);
    await revokeDevice(device, repository, connections);

    return c.json({ ok: true });
  });

  app.get("/vaults", async (c) => c.json(await repository.vaults()));

  app.post("/vaults", async (c) => {
    const vault = v.parse(named, await c.req.json());
    await repository.saveVault(vault);

    return c.json(vault);
  });

  app.get("/vaults/:id", async (c) => {
    const id = v.parse(idSchema, c.req.param("id"));
    const vault = await repository.vault(id);

    return c.json(vault);
  });

  return app;
}
