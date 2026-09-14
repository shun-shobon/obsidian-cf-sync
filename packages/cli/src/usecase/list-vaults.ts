import { resolveCredentials } from "../infra/config/credentials";
import { resolveServerUrl } from "../infra/config/server-url";
import { RestApi } from "../infra/http/api-client";

export async function listVaults(server: string | undefined, env: NodeJS.ProcessEnv) {
  const serverUrl = resolveServerUrl(server, env);
  const credentials = await resolveCredentials(serverUrl, env);
  const api = new RestApi(serverUrl, credentials, crypto.randomUUID(), "");

  const vaults = await api.vaults();

  return { vaults };
}
