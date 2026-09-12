import { idSchema, operationSchema, pathSchema } from "@cf-sync/protocol";
import { z } from "zod";

import { ApplicationError } from "../../domain/errors";
import type { VaultMeta } from "../../domain/vault-state";
import { ApplyOperation } from "../../usecase/apply-operation";
import { BlobStorage } from "../blob-storage";
import type { VaultRepository } from "../vault-repository";
import type { VaultSockets } from "../vault-sockets";

import { json } from "./responses";

export class VaultRoutes {
  private readonly blobs: BlobStorage;
  private readonly operations: ApplyOperation;

  constructor(
    private readonly repository: VaultRepository,
    private readonly sockets: VaultSockets,
    bucket: R2Bucket,
    private readonly meta: VaultMeta,
  ) {
    this.blobs = new BlobStorage(bucket, meta.vaultId);
    this.operations = new ApplyOperation(repository, sockets, this.blobs);
  }

  async handle(request: Request, deviceId: string): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/snapshot") return this.snapshot();
    if (path === "/operations" && request.method === "POST") {
      return json(await this.operations.execute(operationSchema.parse(await request.json())));
    }

    const document = /^\/files\/([^/]+)$/.exec(path);
    if (document && request.method === "GET") {
      const stored = await this.repository.file(idSchema.parse(document[1]));
      return json({ file: stored.file, content: await this.repository.content(stored) });
    }

    if (path === "/exclusions" && request.method === "PUT") return this.exclusions(request);
    if (path === "/tickets" && request.method === "POST") {
      const ticket = await this.sockets.issueTicket(deviceId);
      await this.repository.schedule();
      return json(ticket);
    }

    const blob = /^\/blobs\/([^/]+)$/.exec(path);
    if (blob) return this.blob(request, idSchema.parse(blob[1]));
    throw new ApplicationError("not-found", "Not found");
  }

  private async snapshot(): Promise<Response> {
    return json({ ...this.meta, files: (await this.repository.files()).map((item) => item.file) });
  }

  private async exclusions(request: Request): Promise<Response> {
    const { exclusions } = z
      .object({ exclusions: z.array(pathSchema).max(1000) })
      .parse(await request.json());
    await this.repository.setExclusions(this.meta, exclusions);
    await this.repository.schedule();
    this.sockets.broadcast({ type: "settings", revision: this.meta.revision });
    return this.snapshot();
  }

  private async blob(request: Request, key: string): Promise<Response> {
    if (request.method === "GET") {
      const object = await this.blobs.get(key);
      return new Response(object.body, { headers: { "Content-Type": "application/octet-stream" } });
    }

    if (request.method === "PUT") {
      const expected = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(request.headers.get("X-Content-Digest"));
      const blob = await this.blobs.upload(key, expected, request);
      await this.repository.schedule();
      return json(blob);
    }

    throw new ApplicationError("not-found", "Not found");
  }
}
