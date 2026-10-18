import { normalizeServerUrl } from "../../domain/binding";

export function resolveServerUrl(server: string | undefined, env: NodeJS.ProcessEnv): string {
	const input = server ?? env["CF_SYNC_SERVER_URL"];

	if (input === undefined) {
		throw new Error("Specify --server or CF_SYNC_SERVER_URL");
	}

	return normalizeServerUrl(input);
}
