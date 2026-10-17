import type {
	HttpRequest,
	HttpResponse,
	ServerConnection,
} from "@cf-sync/sync-core/infra/http/http-client";

import type { Credentials } from "../../domain/credentials";

export function serverConnection(origin: string, credentials: Credentials): ServerConnection {
	const authorization = {
		"CF-Access-Client-Id": credentials.clientId,
		"CF-Access-Client-Secret": credentials.clientSecret,
	};

	return { origin, send, authorize: () => Promise.resolve(authorization) };
}

async function send(request: HttpRequest): Promise<HttpResponse> {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
		redirect: "error",
		signal: AbortSignal.timeout(60_000),
	});

	return { status: response.status, bytes: await response.arrayBuffer() };
}
