import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import type { MiniflareOptions } from "miniflare";
import { afterAll, beforeAll } from "vitest";

export function useWorkerRuntime() {
	let script = "";
	const runtimes = new Set<Miniflare>();
	const folders: string[] = [];

	beforeAll(async () => {
		script = await bundleWorker();
	});

	afterAll(async () => {
		await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
		await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
	});

	return {
		start(storage?: string) {
			const mf = new Miniflare(runtimeOptions(script, storage));
			runtimes.add(mf);

			return mf;
		},

		async temporaryDirectory() {
			const folder = await mkdtemp(join(tmpdir(), "cf-sync-test-"));
			folders.push(folder);

			return folder;
		},

		async dispose(mf: Miniflare) {
			runtimes.delete(mf);
			await mf.dispose();
		},
	};
}

async function bundleWorker() {
	const built = await build({
		entryPoints: ["tests/fixtures/worker.ts"],
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: "es2022",
		external: ["cloudflare:workers"],
	});

	return built.outputFiles[0]!.text;
}

function runtimeOptions(script: string, storage: string | undefined): MiniflareOptions {
	const options: MiniflareOptions = {
		modules: true,
		script,
		compatibilityDate: "2026-07-30",
		durableObjects: { VAULTS: { className: "TestVault", useSQLite: true } },
		r2Buckets: ["BUCKET"],
	};

	if (storage === undefined) {
		return options;
	}

	return {
		...options,
		durableObjectsPersist: join(storage, "do"),
		r2Persist: join(storage, "r2"),
	};
}
