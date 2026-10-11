import { mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { AccountApi } from "@cf-sync/sync-core";

import { resolveCredentials } from "../infra/config/credentials";
import { resolveServerUrl } from "../infra/config/server-url";
import { assertSupportedFiles } from "../infra/fs/vault-adapter";
import {
	assertUninitialized,
	ensureMetadataDirectory,
	writeBinding,
} from "../infra/fs/vault-binding";
import { serverConnection } from "../infra/http/server-connection";
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
	const account = new AccountApi(serverConnection(serverUrl, credentials));
	const vaults = await account.vaults();
	const vaultExists = vaults.some((vault) => vault.id === options.vaultId);

	if (!vaultExists) {
		throw new Error("Remote Vault was not found");
	}

	await mkdir(resolve(options.directory), { recursive: true });
	const directory = await realpath(resolve(options.directory));
	const metadata = await ensureMetadataDirectory(directory);
	const unlock = lockVault(metadata);

	try {
		await assertUninitialized(metadata);
		await assertSupportedFiles(directory);
		await account.registerDevice(deviceId, `${hostname()} CLI`);
		await writeBinding(metadata, { serverUrl, vaultId: options.vaultId, deviceId });

		return { initialized: true, directory, serverUrl, vaultId: options.vaultId };
	} finally {
		unlock();
	}
}
