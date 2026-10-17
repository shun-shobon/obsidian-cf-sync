import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { VaultApi } from "@cf-sync/sync-core/infra/http/server-api";
import type { SyncPlan } from "@cf-sync/sync-core/sync/domain/sync-plan";
import type { SyncResult } from "@cf-sync/sync-core/sync/domain/sync-result";
import { PlanSync } from "@cf-sync/sync-core/sync/usecase/plan-sync";
import { SyncOnce } from "@cf-sync/sync-core/sync/usecase/sync-once";
import type { SyncOnceOptions } from "@cf-sync/sync-core/sync/usecase/sync-once-options";

import { normalizeServerUrl } from "../domain/binding";
import { resolveCredentials } from "../infra/config/credentials";
import { FileVault } from "../infra/fs/vault-adapter";
import { metadataName, readBinding, validateMetadata } from "../infra/fs/vault-binding";
import { serverConnection } from "../infra/http/server-connection";
import { SqliteStore } from "../infra/storage/sqlite-store";
import { lockVault } from "../infra/storage/vault-lock";

export async function synchronizeVault(
	directory: string,
	env: NodeJS.ProcessEnv,
): Promise<SyncResult> {
	return await withVault(directory, env, false, (ports) => new SyncOnce(ports).run());
}

export async function planSynchronization(
	directory: string,
	env: NodeJS.ProcessEnv,
): Promise<SyncPlan> {
	return await withVault(directory, env, true, (ports) => new PlanSync(ports).run());
}

async function withVault<T>(
	directory: string,
	env: NodeJS.ProcessEnv,
	dryRun: boolean,
	run: (ports: SyncOnceOptions) => Promise<T>,
): Promise<T> {
	const root = await realpath(directory);
	const metadata = join(root, metadataName);

	await validateMetadata(metadata);
	const unlock = lockVault(metadata);

	try {
		const binding = await readBinding(metadata);
		assertSameServer(binding.serverUrl, env["CF_SYNC_SERVER_URL"]);

		const credentials = await resolveCredentials(binding.serverUrl, env);
		const server = serverConnection(binding.serverUrl, credentials);
		const api = new VaultApi(server, binding.deviceId, binding.vaultId);
		const store = new SqliteStore(join(metadata, "state.sqlite"), dryRun);

		try {
			return await run({ api, store, vault: new FileVault(root) });
		} finally {
			store.close();
		}
	} finally {
		unlock();
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
