import { mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";

import { FileVault } from "../infra/fs/vault-adapter";
import {
	assertUninitialized,
	ensureMetadataDirectory,
	writeBinding,
} from "../infra/fs/vault-binding";
import { lockVault } from "../infra/storage/vault-lock";
import { connectAccount } from "./connect-account";

interface InitializeOptions {
	directory: string;
	server?: string;
	vaultId: string;
}

export async function initializeVault(options: InitializeOptions, env: NodeJS.ProcessEnv) {
	const { serverUrl, account } = await connectAccount(options.server, env);
	const deviceId = crypto.randomUUID();
	const vaults = await account.vaults();
	const vaultExists = vaults.some((vault) => vault.id === options.vaultId);

	if (!vaultExists) {
		throw new Error("Remote Vault was not found");
	}

	await mkdir(options.directory, { recursive: true });
	const directory = await realpath(options.directory);
	const metadata = await ensureMetadataDirectory(directory);
	const unlock = lockVault(metadata);

	try {
		await assertUninitialized(metadata);
		await new FileVault(directory).list();
		await account.registerDevice(deviceId, `${hostname()} CLI`);
		await writeBinding(metadata, { serverUrl, vaultId: options.vaultId, deviceId });

		return { initialized: true, directory, serverUrl, vaultId: options.vaultId };
	} finally {
		unlock();
	}
}
