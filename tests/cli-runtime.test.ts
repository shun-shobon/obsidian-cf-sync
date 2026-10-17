import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ConnectionError } from "@cf-sync/sync-core/domain/connection-error";
import { AccountApi, VaultApi } from "@cf-sync/sync-core/infra/http/server-api";
import { PlanSync } from "@cf-sync/sync-core/sync/usecase/plan-sync";
import { SyncOnce } from "@cf-sync/sync-core/sync/usecase/sync-once";
import type { SyncOnceOptions } from "@cf-sync/sync-core/sync/usecase/sync-once-options";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileVault } from "../packages/cli/src/infra/fs/vault-adapter";
import { ensureMetadataDirectory } from "../packages/cli/src/infra/fs/vault-binding";
import { serverConnection } from "../packages/cli/src/infra/http/server-connection";
import { SqliteStore } from "../packages/cli/src/infra/storage/sqlite-store";
import { syncExitCode } from "../packages/cli/src/presentation/output";
import { TEST_ACCESS_ASSERTION } from "./fixtures/access-auth";
import { useWorkerRuntime } from "./helpers/worker-runtime";

const runtime = useWorkerRuntime();
const encode = (text: string) => new TextEncoder().encode(text);

afterEach(() => {
	vi.unstubAllGlobals();
});

async function start() {
	const mf = runtime.start();
	let loseAcknowledgment = false;
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		expect(request.headers.get("CF-Access-Client-Id")).toBe("cli-client.access");
		expect(request.headers.get("CF-Access-Client-Secret")).toBe("test-secret");
		const headers = new Headers(request.headers);
		headers.set("Cf-Access-Jwt-Assertion", TEST_ACCESS_ASSERTION);
		const response = await mf.dispatchFetch(request.url, {
			method: request.method,
			headers: Object.fromEntries(headers),
			body: request.body ? await request.arrayBuffer() : undefined,
		});
		if (loseAcknowledgment && new URL(request.url).pathname.endsWith("/operations")) {
			loseAcknowledgment = false;
			await response.arrayBuffer();
			throw new Error("Connection lost after the Worker accepted the operation");
		}
		return new Response(await response.arrayBuffer(), {
			status: response.status,
			headers: Object.fromEntries(response.headers),
		});
	};
	vi.stubGlobal("fetch", fetcher);
	const server = serverConnection("https://test", {
		clientId: "cli-client.access",
		clientSecret: "test-secret",
	});
	const account = new AccountApi(server);
	const { id: vaultId } = await account.createVault("CLI vault");
	return async () => {
		const root = await runtime.temporaryDirectory();
		const metadata = await ensureMetadataDirectory(root);
		const vault = new FileVault(root);
		const deviceId = crypto.randomUUID();
		await account.registerDevice(deviceId, "CLI device");
		const api = new VaultApi(server, deviceId, vaultId);
		const withStore = async <T>(dryRun: boolean, use: (ports: SyncOnceOptions) => Promise<T>) => {
			const store = new SqliteStore(join(metadata, "state.sqlite"), dryRun);
			try {
				return await use({ vault, store, api });
			} finally {
				store.close();
			}
		};
		return {
			root,
			vault,
			api,
			run: () => withStore(false, (ports) => new SyncOnce(ports).run()),
			plan: () => withStore(true, (ports) => new PlanSync(ports).run()),
			loseNextAcknowledgment: () => {
				loseAcknowledgment = true;
			},
		};
	};
}

async function contents(root: string) {
	const result: Record<string, Buffer> = {};
	for (const path of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (path.isFile()) {
			const absolute = join(path.parentPath, path.name);
			result[absolute.slice(root.length + 1)] = await readFile(absolute);
		}
	}
	return result;
}

describe("CLI filesystem and SQLite against the real Worker", () => {
	it("merges independent offline text edits and preserves an edit racing with deletion", async () => {
		const client = await start();
		const left = await client();
		const right = await client();
		await left.vault.write("note.md", encode("base"));
		await left.run();
		await right.run();
		await left.vault.write("note.md", encode("LEFT base"));
		await right.vault.write("note.md", encode("base RIGHT"));
		await Promise.all([left.run(), right.run()]);
		await left.run();
		await right.run();
		expect(new TextDecoder().decode(await left.vault.read("note.md"))).toBe("LEFT base RIGHT");
		expect(new TextDecoder().decode(await right.vault.read("note.md"))).toBe("LEFT base RIGHT");

		await left.vault.write("note.md", encode("edited before deletion arrived"));
		await left.run();
		await right.vault.remove("note.md");
		await expect(right.run()).resolves.toMatchObject({
			pending: 0,
			conflicts: [expect.anything()],
		});
		await left.run();
		const paths = await right.vault.list();
		expect(paths).toHaveLength(1);
		expect(paths).not.toContain("note.md");
		expect(await left.vault.list()).toEqual(paths);
		expect(new TextDecoder().decode(await right.vault.read(paths[0]!))).toBe(
			"edited before deletion arrived",
		);
	}, 30_000);

	it("replays persisted pending operations after a lost acknowledgment without duplication", async () => {
		const client = await start();
		const local = await client();
		await local.vault.write("note.md", encode("survives interruption"));
		local.loseNextAcknowledgment();
		await expect(local.run()).rejects.toBeInstanceOf(ConnectionError);
		const accepted = await local.api.snapshot();
		expect(accepted.files).toHaveLength(1);
		await expect(local.run()).resolves.toMatchObject({ pending: 0, revision: accepted.revision });
		expect(await local.api.snapshot()).toEqual(accepted);
		expect(new TextDecoder().decode(await local.vault.read("note.md"))).toBe(
			"survives interruption",
		);
	}, 30_000);

	it("round-trips text and blobs, reopens state, and propagates edits and deletions", async () => {
		const client = await start();
		const left = await client();
		const right = await client();
		const blob = new Uint8Array([0, 255, 1, 128, 42]);
		await left.vault.write("日記/note.md", encode("base"));
		await left.vault.write("assets/image.png", blob);
		await left.run();
		await right.run();
		expect(new Uint8Array(await right.vault.read("日記/note.md"))).toEqual(encode("base"));
		expect(new Uint8Array(await right.vault.read("assets/image.png"))).toEqual(blob);
		const initial = await left.api.snapshot();
		await right.run();
		await left.run();
		expect(await left.api.snapshot()).toEqual(initial);

		await right.vault.write("日記/note.md", encode("edited from CLI"));
		await right.vault.write("assets/image.png", new Uint8Array([3, 2, 1]));
		await right.run();
		await left.run();
		expect(new Uint8Array(await left.vault.read("日記/note.md"))).toEqual(
			encode("edited from CLI"),
		);
		expect(new Uint8Array(await left.vault.read("assets/image.png"))).toEqual(
			new Uint8Array([3, 2, 1]),
		);

		await left.vault.remove("日記/note.md");
		await left.run();
		await right.run();
		expect(await right.vault.list()).toEqual(["assets/image.png"]);
		expect((await right.api.snapshot()).files.map((file) => file.path)).toEqual([
			"assets/image.png",
		]);
	}, 30_000);

	it("preserves both versions of an initial path collision and converges on rerun", async () => {
		const client = await start();
		const left = await client();
		const right = await client();
		await left.vault.write("note.md", encode("remote version"));
		await right.vault.write("note.md", encode("local version"));
		await left.run();
		const result = await right.run();
		expect(result).toMatchObject({
			pending: 0,
			conflicts: [expect.objectContaining({ kind: "text" })],
		});
		expect(syncExitCode(result)).toBe(2);
		await left.run();
		const paths = await right.vault.list();
		expect(paths).toHaveLength(2);
		expect(await left.vault.list()).toEqual(paths);
		const texts = await Promise.all(
			paths.map(async (path) => new TextDecoder().decode(await right.vault.read(path))),
		);
		texts.sort();
		expect(texts).toEqual(["local version", "remote version"]);
		const snapshot = await right.api.snapshot();
		const repeated = await right.run();
		expect(repeated).toMatchObject({ pending: 0, conflicts: [] });
		expect(syncExitCode(repeated)).toBe(0);
		expect(await right.api.snapshot()).toEqual(snapshot);

		const store = new SqliteStore(join(right.root, ".cf-sync/state.sqlite"));
		try {
			expect((await store.load())?.conflictIds).toEqual(result.conflicts.map((file) => file.id));
		} finally {
			store.close();
		}
	}, 30_000);

	it("plans uploads and downloads without changing files, SQLite data, or remote revision", async () => {
		const client = await start();
		const left = await client();
		const right = await client();
		await left.vault.write("base.md", encode("base"));
		await left.run();
		await right.run();
		await left.vault.write("remote.md", encode("remote addition"));
		await left.run();
		await right.vault.write("local.md", encode("local addition"));
		const before = await contents(right.root);
		const remote = await right.api.snapshot();
		const plan = await right.plan();
		expect(plan).toMatchObject({
			uploads: [expect.objectContaining({ path: "local.md", action: "create" })],
			downloads: [expect.objectContaining({ path: "remote.md", action: "write" })],
		});
		expect(await contents(right.root)).toEqual(before);
		expect(await right.api.snapshot()).toEqual(remote);
		await right.run();
		expect(await right.vault.list()).toEqual(["base.md", "local.md", "remote.md"]);
	}, 30_000);
});
