import { Account } from "../../packages/worker/src/infra/durable-objects/account";
import { Vault } from "../../packages/worker/src/infra/durable-objects/vault";
import type { Env } from "../../packages/worker/src/infra/env";

export { Account };

export class TestVault extends Vault {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/flush") {
      await this.alarm();
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = request.headers.get("X-Vault-Id");
    if (!id) {
      return new Response("Missing test vault", { status: 400 });
    }
    return env.VAULTS.get(env.VAULTS.idFromName(id)).fetch(request);
  },
};
