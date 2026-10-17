import * as v from "valibot";

import { t } from "../../i18n";
import type { Transport } from "../http/transport";
import { discoverAuthorizationServer } from "./oauth-discovery";

const clientRegistrationSchema = v.object({
	client_id: v.pipe(v.string(), v.minLength(1)),
});

export async function registerClient(origin: string, transport: Transport) {
	const { metadata, resource } = await discoverAuthorizationServer(origin, transport);

	const response = await transport({
		url: metadata.registration_endpoint,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			resource,
			client_name: "Obsidian CF Sync",
			redirect_uris: [`${origin}/oauth/callback`],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(t(($) => $.errors.providerFailed, { status: response.status }));
	}

	const registration = v.parse(clientRegistrationSchema, JSON.parse(response.text));

	return { clientId: registration.client_id, metadata, resource };
}
