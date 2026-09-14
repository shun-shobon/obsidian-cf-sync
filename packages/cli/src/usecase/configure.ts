import { writeConfig } from "../infra/config/config-file";
import { requireEnvironmentCredentials } from "../infra/config/credentials";
import { resolveServerUrl } from "../infra/config/server-url";

export async function configure(server: string | undefined, env: NodeJS.ProcessEnv) {
  const serverUrl = resolveServerUrl(server, env);
  const credentials = requireEnvironmentCredentials(env);

  await writeConfig(serverUrl, credentials, env);

  return { configured: true, serverUrl };
}
