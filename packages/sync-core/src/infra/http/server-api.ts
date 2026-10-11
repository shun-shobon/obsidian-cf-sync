import {
	blobSchema,
	connectionTicketSchema,
	deviceSchema,
	documentSchema,
	operationResultSchema,
	snapshotSchema,
	vaultInfoSchema,
} from "@cf-sync/protocol";
import type { BlobRef, Operation } from "@cf-sync/protocol";
import * as v from "valibot";

import { DocumentNotFoundError } from "../../domain/document-not-found-error";
import { t } from "../../i18n";
import type { RestApiPort } from "../../sync/ports/api-port";
import { HttpClient } from "./http-client";
import type { ServerConnection } from "./http-client";

export class AccountApi {
	private readonly http: HttpClient;

	constructor(server: ServerConnection) {
		this.http = new HttpClient(server);
	}

	async vaults() {
		const response = await this.http.json("/api/vaults");

		return v.parse(v.array(vaultInfoSchema), response);
	}

	async createVault(name: string) {
		const body = JSON.stringify({ id: crypto.randomUUID(), name });
		const response = await this.http.json("/api/vaults", { method: "POST", body });

		return v.parse(vaultInfoSchema, response);
	}

	async devices() {
		const response = await this.http.json("/api/devices");

		return v.parse(v.array(deviceSchema), response);
	}

	async registerDevice(id: string, name: string) {
		const body = JSON.stringify({ id, name });
		const response = await this.http.json("/api/devices", { method: "POST", body });

		return v.parse(deviceSchema, response);
	}

	async revokeDevice(id: string) {
		await this.http.json(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
	}
}

export class VaultApi implements RestApiPort {
	private readonly http: HttpClient;

	constructor(
		server: ServerConnection,
		deviceId: string,
		private readonly vaultId: string,
	) {
		this.http = new HttpClient(server, { "X-Device-Id": deviceId });
	}

	private path(suffix: string): string {
		return `/api/vaults/${encodeURIComponent(this.vaultId)}${suffix}`;
	}

	async snapshot() {
		const response = await this.http.json(this.path("/snapshot"));

		return v.parse(snapshotSchema, response);
	}

	async document(id: string) {
		const response = await this.http.json(this.path(`/files/${encodeURIComponent(id)}`), {
			notFound: () => new DocumentNotFoundError(t(($) => $.errors.documentDeleted)),
		});

		return v.parse(documentSchema, response);
	}

	async operate(operation: Operation) {
		const body = JSON.stringify(operation);
		const response = await this.http.json(this.path("/operations"), { method: "POST", body });

		return v.parse(operationResultSchema, response);
	}

	async upload(key: string, bytes: Uint8Array, digest: string) {
		const response = await this.http.json(this.path(`/blobs/${encodeURIComponent(key)}`), {
			method: "PUT",
			body: new Uint8Array(bytes).buffer,
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Content-Digest": digest,
				"X-Content-Size": String(bytes.byteLength),
			},
		});

		return v.parse(blobSchema, response);
	}

	async download(ref: BlobRef) {
		const bytes = await this.http.request(this.path(`/blobs/${encodeURIComponent(ref.key)}`));

		return new Uint8Array(bytes);
	}

	async exclusions(exclusions: string[]) {
		const body = JSON.stringify({ exclusions });
		const response = await this.http.json(this.path("/exclusions"), { method: "PUT", body });

		return v.parse(snapshotSchema, response);
	}

	async ticket() {
		const response = await this.http.json(this.path("/tickets"), { method: "POST" });

		return v.parse(connectionTicketSchema, response);
	}
}
