import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PlanSync, SyncOnce, type SyncPlan, type SyncResult } from "@cf-sync/sync-core";

import { normalizeServerUrl } from "../domain/connection";
import { resolveCredentials } from "../infra/config/credentials";
import { FileVault } from "../infra/fs/vault-adapter";
import { metadataName, readBinding, validateMetadata } from "../infra/fs/vault-binding";
import { RestApi } from "../infra/http/api-client";
import { SqliteStore } from "../infra/storage/sqlite-store";
import { lockVault } from "../infra/storage/vault-lock";

export interface SynchronizeOptions {
  directory: string;
  dryRun: boolean;
}

export type SynchronizeResult =
  | { mode: "plan"; plan: SyncPlan }
  | { mode: "sync"; sync: SyncResult };

export async function synchronizeVault(
  options: SynchronizeOptions,
  env: NodeJS.ProcessEnv,
): Promise<SynchronizeResult> {
  const root = await realpath(resolve(options.directory));
  const metadata = join(root, metadataName);

  await validateMetadata(metadata);
  const unlock = await lockVault(metadata);

  try {
    const binding = await readBinding(metadata);
    const origin = normalizeServerUrl(binding.serverUrl);
    assertSameServer(origin, env["CF_SYNC_SERVER_URL"]);

    const credentials = await resolveCredentials(origin, env);
    const api = new RestApi(origin, credentials, binding.deviceId, binding.vaultId);
    const store = new SqliteStore(join(metadata, "state.sqlite"), options.dryRun);

    try {
      const ports = { api, store, vault: new FileVault(root) };

      if (options.dryRun) {
        return { mode: "plan", plan: await new PlanSync(ports).run() };
      }

      return { mode: "sync", sync: await new SyncOnce(ports).run() };
    } finally {
      store.close();
    }
  } finally {
    await unlock();
  }
}

function assertSameServer(origin: string, configured: string | undefined): void {
  if (configured === undefined) {
    return;
  }

  if (normalizeServerUrl(configured) !== origin) {
    throw new Error("CF_SYNC_SERVER_URL differs from the initialized server");
  }
}
