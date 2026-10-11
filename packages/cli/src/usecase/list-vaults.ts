import { AccountApi } from "@cf-sync/sync-core";

import { resolveCredentials } from "../infra/config/credentials";
import { resolveServerUrl } from "../infra/config/server-url";
import { serverConnection } from "../infra/http/server-connection";

export async function listVaults(server: string | undefined, env: NodeJS.ProcessEnv) {
	const serverUrl = resolveServerUrl(server, env);
	const credentials = await resolveCredentials(serverUrl, env);
	const account = new AccountApi(serverConnection(serverUrl, credentials));
	const vaults = await account.vaults();

	return { vaults };
}
