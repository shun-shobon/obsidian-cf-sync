import type {
	HttpRequest as ServerRequest,
	HttpResponse as ServerResponse,
} from "@cf-sync/sync-core/infra/http/http-client";

export interface HttpRequest extends Omit<ServerRequest, "headers"> {
	headers?: ServerRequest["headers"];
}

export interface HttpResponse extends ServerResponse {
	headers: Record<string, string>;
	text: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
