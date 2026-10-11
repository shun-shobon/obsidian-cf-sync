import { ConnectionError } from "../../domain/connection-error";
import { t } from "../../i18n";

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
}

export interface HttpResponse {
	status: number;
	bytes: ArrayBuffer;
}

export interface ServerConnection {
	origin: string;
	send: (request: HttpRequest) => Promise<HttpResponse>;
	authorize: () => Promise<Record<string, string>>;
}

export interface RequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	notFound?: () => Error;
}

export class HttpClient {
	constructor(
		private readonly server: ServerConnection,
		private readonly headers: Record<string, string> = {},
	) {}

	async json(path: string, options: RequestOptions = {}): Promise<unknown> {
		const headers = { "Content-Type": "application/json", ...options.headers };
		const bytes = await this.request(path, { ...options, headers });

		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	}

	async request(path: string, options: RequestOptions = {}): Promise<ArrayBuffer> {
		const authorization = await this.server.authorize();
		const request: HttpRequest = {
			url: this.server.origin + path,
			method: options.method ?? "GET",
			headers: { ...options.headers, ...this.headers, ...authorization },
		};

		if (options.body !== undefined) {
			request.body = options.body;
		}

		const response = await this.server.send(request).catch((cause: unknown) => {
			throw new ConnectionError(
				t(($) => $.errors.serverUnavailable),
				{ cause },
			);
		});

		if (response.status >= 200 && response.status < 300) {
			return response.bytes;
		}

		throw failure(response.status, options.notFound);
	}
}

function failure(status: number, notFound: (() => Error) | undefined): Error {
	if (status === 404 && notFound) {
		return notFound();
	}

	if (status === 401 || status === 403) {
		return new Error(t(($) => $.errors.accessDenied));
	}

	const message = t(($) => $.errors.apiFailed, { status });

	if (status >= 500 || status === 429) {
		return new ConnectionError(message);
	}

	return new Error(message);
}
