import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import type { Plugin } from "esbuild";
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

const accessAuth = fileURLToPath(
	new URL("../../packages/worker/src/infra/access-auth.ts", import.meta.url),
);
const testAccessAuth = fileURLToPath(new URL("../fixtures/access-auth.ts", import.meta.url));

// Tests cannot obtain assertions signed by Access, so only the JWT verification module is replaced.
const replaceAccessAuth: Plugin = {
	name: "replace-access-auth",
	setup(builder) {
		// oxlint-disable-next-line eslint/require-unicode-regexp -- esbuild compiles filters as Go regular expressions, which reject the u flag.
		builder.onResolve({ filter: /\/access-auth$/ }, (args) => {
			if (resolve(args.resolveDir, `${args.path}.ts`) !== accessAuth) {
				return undefined;
			}

			return { path: testAccessAuth };
		});
	},
};

async function bundleWorker() {
	const built = await build({
		entryPoints: ["tests/fixtures/worker.ts"],
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: "es2022",
		external: ["cloudflare:workers"],
		plugins: [replaceAccessAuth],
	});

	return built.outputFiles[0]!.text;
}

function runtimeOptions(script: string, storage: string | undefined): MiniflareOptions {
	const options: MiniflareOptions = {
		modules: true,
		script,
		compatibilityDate: "2026-07-30",
		durableObjects: {
			ACCOUNT: { className: "AccountDO", useSQLite: true },
			VAULTS: { className: "TestVault", useSQLite: true },
		},
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
