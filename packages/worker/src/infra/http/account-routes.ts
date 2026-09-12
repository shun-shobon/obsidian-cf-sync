import { idSchema } from "@cf-sync/protocol";
import { Hono } from "hono";
import { z } from "zod";

import { ApplicationError } from "../../domain/errors";
import type { DeviceConnections } from "../../usecase/ports";
import { revokeDevice } from "../../usecase/revoke-device";
import type { AccountRepository } from "../account-repository";

import { notFound, onError } from "./responses";

const named = z.object({ id: idSchema, name: z.string().trim().min(1).max(200) });

export function accountRoutes(repository: AccountRepository, connections: DeviceConnections) {
  const app = new Hono();
  app.onError(onError);
  app.notFound(notFound);
  app.get("/devices", async (c) => c.json(await repository.devices()));
  app.post("/devices", async (c) =>
    c.json(await repository.registerDevice(named.parse(await c.req.json()))),
  );
  app.get("/devices/:id", async (c) => {
    const device = await repository.device(idSchema.parse(c.req.param("id")));
    if (device.revoked) throw new ApplicationError("forbidden", "Device revoked");
    return c.json(device);
  });
  app.delete("/devices/:id", async (c) => {
    const device = await repository.device(idSchema.parse(c.req.param("id")));
    await revokeDevice(device, repository, connections);
    return c.json({ ok: true });
  });
  app.get("/vaults", async (c) => c.json(await repository.vaults()));
  app.post("/vaults", async (c) => {
    const vault = named.parse(await c.req.json());
    await repository.saveVault(vault);
    return c.json(vault);
  });
  app.get("/vaults/:id", async (c) =>
    c.json(await repository.vault(idSchema.parse(c.req.param("id")))),
  );
  return app;
}
