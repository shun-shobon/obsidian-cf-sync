import { normalizeServerUrl } from "../../domain/connection";

export function resolveServerUrl(server: string | undefined, env: NodeJS.ProcessEnv): string {
  let input = env["CF_SYNC_SERVER_URL"];

  if (input === undefined) {
    input = server;
  }

  if (input === undefined) {
    throw new Error("Specify --server or CF_SYNC_SERVER_URL");
  }

  return normalizeServerUrl(input);
}
