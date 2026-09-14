import { mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { resolveCredentials } from "../infra/config/credentials";
import { resolveServerUrl } from "../infra/config/server-url";
import { FileVault } from "../infra/fs/vault-adapter";
import {
  assertUninitialized,
  ensureMetadataDirectory,
  writeBinding,
} from "../infra/fs/vault-binding";
import { RestApi } from "../infra/http/api-client";
import { lockVault } from "../infra/storage/vault-lock";

export interface InitializeOptions {
  directory: string;
  server?: string;
  vaultId: string;
}

export async function initializeVault(options: InitializeOptions, env: NodeJS.ProcessEnv) {
  const serverUrl = resolveServerUrl(options.server, env);
  const credentials = await resolveCredentials(serverUrl, env);
  const deviceId = crypto.randomUUID();
  const api = new RestApi(serverUrl, credentials, deviceId, options.vaultId);
  const vaults = await api.vaults();
  const vaultExists = vaults.some((vault) => vault.id === options.vaultId);

  if (!vaultExists) {
    throw new Error("Remote Vault was not found");
  }

  await mkdir(resolve(options.directory), { recursive: true });
  const directory = await realpath(resolve(options.directory));
  const metadata = await ensureMetadataDirectory(directory);
  const unlock = await lockVault(metadata);

  try {
    await assertUninitialized(metadata);
    await new FileVault(directory).list();
    await api.registerDevice(`${hostname()} CLI`);
    await writeBinding(metadata, { serverUrl, vaultId: options.vaultId, deviceId });

    return { initialized: true, directory, serverUrl, vaultId: options.vaultId };
  } finally {
    await unlock();
  }
}
