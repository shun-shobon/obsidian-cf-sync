import { idSchema, parseServerOrigin } from "@cf-sync/protocol";
import * as v from "valibot";

export function normalizeServerUrl(value: string): string {
	const origin = parseServerOrigin(value, { allowLocalHttp: true });

	if (origin === undefined) {
		throw new Error(
			"Server URL must be an HTTPS origin without a path (HTTP is allowed for localhost)",
		);
	}

	return origin;
}

export const bindingSchema = v.object({
	serverUrl: v.pipe(v.string(), v.transform(normalizeServerUrl)),
	vaultId: idSchema,
	deviceId: idSchema,
});

export type Binding = v.InferOutput<typeof bindingSchema>;
