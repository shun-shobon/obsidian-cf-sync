import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PlanSync, SyncOnce, type SyncResult } from "@cf-sync/sync-core";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FileVault } from "../packages/cli/src/infra/fs/vault-adapter";
import { ensureMetadataDirectory } from "../packages/cli/src/infra/fs/vault-binding";
import { RestApi } from "../packages/cli/src/infra/http/api-client";
import { SqliteStore } from "../packages/cli/src/infra/storage/sqlite-store";
import { syncExitCode } from "../packages/cli/src/presentation/output";

let script: string;
const runtimes: Miniflare[] = [];
const folders: string[] = [];
const encode = (text: string) => new TextEncoder().encode(text);

beforeAll(async () => {
  const built = await build({
    entryPoints: ["tests/fixtures/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
  });
  script = built.outputFiles[0]!.text;
});

afterAll(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.dispose()));
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

async function start() {
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    durableObjects: {
      VAULTS: { className: "TestVault", useSQLite: true },
      ACCOUNT: { className: "Account", useSQLite: true },
    },
    r2Buckets: ["BUCKET"],
  });
  runtimes.push(mf);
  const vaultId = crypto.randomUUID();
  let loseAcknowledgment = false;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("CF-Access-Client-Id")).toBe("cli-client.access");
    expect(request.headers.get("CF-Access-Client-Secret")).toBe("test-secret");
    const prefix = `/api/vaults/${vaultId}`;
    const url = new URL(request.url);
    expect(url.pathname.startsWith(prefix + "/")).toBe(true);
    const headers = new Headers(request.headers);
    headers.set("X-Vault-Id", vaultId);
    const response = await mf.dispatchFetch(`https://test${url.pathname.slice(prefix.length)}`, {
      method: request.method,
      headers: Object.fromEntries(headers),
      body: request.body ? await request.arrayBuffer() : undefined,
    });
    if (loseAcknowledgment && url.pathname.endsWith("/operations")) {
      loseAcknowledgment = false;
      await response.arrayBuffer();
      throw new Error("Connection lost after the Worker accepted the operation");
    }
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  };
  return async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-sync-cli-"));
    folders.push(root);
    const metadata = await ensureMetadataDirectory(root);
    const vault = new FileVault(root);
    const api = new RestApi(
      "https://test",
      { clientId: "cli-client.access", clientSecret: "test-secret" },
      crypto.randomUUID(),
      vaultId,
      fetcher,
    );
    const run = async (dryRun = false) => {
      const store = new SqliteStore(join(metadata, "state.sqlite"));
      try {
        return dryRun
          ? await new PlanSync({ vault, store, api }).run()
          : await new SyncOnce({ vault, store, api }).run();
      } finally {
        store.close();
      }
    };
    return {
      root,
      vault,
      api,
      run,
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
    await expect(local.run()).rejects.toThrow("Connection lost");
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
    expect(syncExitCode(result as SyncResult)).toBe(2);
    await left.run();
    const paths = await right.vault.list();
    expect(paths).toHaveLength(2);
    expect(await left.vault.list()).toEqual(paths);
    expect(
      (
        await Promise.all(
          paths.map(async (path) => new TextDecoder().decode(await right.vault.read(path))),
        )
      ).sort(),
    ).toEqual(["local version", "remote version"]);
    const snapshot = await right.api.snapshot();
    const repeated = await right.run();
    expect(repeated).toMatchObject({ pending: 0, conflicts: [] });
    expect(syncExitCode(repeated as SyncResult)).toBe(0);
    expect(await right.api.snapshot()).toEqual(snapshot);

    const store = new SqliteStore(join(right.root, ".cf-sync/state.sqlite"));
    try {
      expect((await store.load())?.conflicts).toEqual((result as SyncResult).conflicts);
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
    const plan = await right.run(true);
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
