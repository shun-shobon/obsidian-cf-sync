import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SyncOnce } from "@cf-sync/sync-core";
import { runCommand } from "citty";
import { build } from "tsdown";
import { afterEach, expect, it, vi } from "vitest";

import { createCommands } from "../src/presentation/commands";
import type { CliContext } from "../src/presentation/context";
import buildConfig from "../tsdown.config";

const vaultId = "a1ae5d78-e60e-4de8-820e-cf67b4e082a4";
const origin = "https://sync.example";
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cf-sync-commands-")));
  directories.push(directory);
  const env = {
    XDG_CONFIG_HOME: join(directory, "config"),
    CF_ACCESS_CLIENT_ID: "service-id",
    CF_ACCESS_CLIENT_SECRET: "service-secret",
  };
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    requests.push(request);
    const path = new URL(url).pathname;
    if (path === "/api/vaults" && request.method === "GET")
      return Response.json([{ id: vaultId, name: "Notes" }]);
    if (path === "/api/devices" && request.method === "POST")
      return Response.json({ ...(await request.clone().json()), revoked: false });
    if (path === `/api/vaults/${vaultId}/snapshot`)
      return Response.json({ revision: 0, r2Revision: 0, files: [], exclusions: [] });
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  });
  const root = join(directory, "vault");
  const output: string[] = [];
  const invoke = async (args: string[], environment: NodeJS.ProcessEnv = env) => {
    const context: CliContext = {
      env: environment,
      output: (line) => output.push(line),
      exitCode: 0,
    };

    await runCommand(createCommands(context), { rawArgs: args });

    return context.exitCode;
  };
  const initialize = () => invoke(["init", root, "--server", origin, "--vault", vaultId, "--json"]);
  return { directory, env, requests, root, output, invoke, initialize };
}

it("runs config, vault list and init through the HTTP contract and records the binding", async () => {
  const f = await fixture();
  expect(await f.invoke(["config", "--server", origin, "--json"])).toBe(0);
  expect(JSON.parse(f.output.pop()!)).toEqual({ configured: true, serverUrl: origin });
  expect(
    await f.invoke(["vault", "list", "--server", origin, "--json"], {
      XDG_CONFIG_HOME: f.env.XDG_CONFIG_HOME,
    }),
  ).toBe(0);
  expect(JSON.parse(f.output.pop()!)).toEqual({ vaults: [{ id: vaultId, name: "Notes" }] });
  expect(await f.initialize()).toBe(0);
  const result = JSON.parse(f.output.pop()!);
  expect(result).toEqual({ initialized: true, directory: f.root, serverUrl: origin, vaultId });
  const binding = JSON.parse(await readFile(join(f.root, ".cf-sync/vault.json"), "utf8"));
  const registration = f.requests.find((request) => request.method === "POST")!;
  expect(await registration.clone().json()).toEqual({
    id: binding.deviceId,
    name: expect.stringContaining("CLI"),
  });
  expect(binding).toEqual({
    serverUrl: origin,
    vaultId,
    deviceId: registration.headers.get("X-Device-Id"),
  });
  for (const request of f.requests) {
    expect(request.headers.get("CF-Access-Client-Id")).toBe("service-id");
    expect(request.headers.get("CF-Access-Client-Secret")).toBe("service-secret");
    expect(request.headers.get("Authorization")).toBeNull();
  }
});

it("runs sync JSON and dry-run without uploading local changes or modifying Vault state", async () => {
  const f = await fixture();
  await f.initialize();
  expect(await f.invoke(["sync", f.root, "--json"])).toBe(0);
  expect(JSON.parse(f.output.pop()!)).toEqual({
    revision: 0,
    r2Revision: 0,
    pending: 0,
    conflicts: [],
  });
  await writeFile(join(f.root, "note.md"), "new note");
  const before = await readFile(join(f.root, ".cf-sync/state.sqlite"));
  expect(await f.invoke(["sync", f.root, "--dry-run", "--json"])).toBe(0);
  expect(JSON.parse(f.output.pop()!)).toEqual({
    dryRun: true,
    uploads: [{ path: "note.md", action: "create" }],
    downloads: [],
  });
  expect(await readFile(join(f.root, ".cf-sync/state.sqlite"))).toEqual(before);
  expect(await readdir(f.root)).toEqual([".cf-sync", "note.md"]);
  expect(f.requests.filter((request) => request.method !== "GET")).toHaveLength(1);
});

it("returns exit 2 and JSON conflict details from the sync result", async () => {
  const f = await fixture();
  await f.initialize();
  const conflict = {
    id: vaultId,
    path: "note.conflict.md",
    kind: "text" as const,
    revision: 1,
    pathRevision: 1,
    digest: "digest",
    size: 1,
    conflict: true,
  };
  vi.spyOn(SyncOnce.prototype, "run").mockResolvedValueOnce({
    revision: 1,
    r2Revision: 0,
    pending: 0,
    conflicts: [conflict],
  });
  expect(await f.invoke(["sync", f.root, "--json"])).toBe(2);
  expect(JSON.parse(f.output.pop()!).conflicts).toEqual([conflict]);
});

it("uses Citty help and error handling from the bundled entry point", async () => {
  const f = await fixture();
  const executable = join(f.directory, "bundle", "cli.mjs");
  await build({
    ...buildConfig,
    config: false,
    entry: { cli: fileURLToPath(new URL("../src/main.ts", import.meta.url)) },
    outDir: join(f.directory, "bundle"),
    outputOptions: { entryFileNames: "cli.mjs" },
  });

  for (const args of [
    ["--help"],
    ["vault", "list", "--help"],
    ["init", "--help"],
    ["sync", "-h"],
  ]) {
    const result = spawnSync(process.execPath, [executable, ...args], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("USAGE");
  }

  const result = spawnSync(process.execPath, [executable, "unknown-command"], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unknown command unknown-command");
});

it("lets Citty reject missing required arguments and unknown subcommands", async () => {
  const f = await fixture();

  for (const args of [["init", "--server", origin], ["vault", "unknown"], ["vault"]]) {
    await expect(f.invoke(args)).rejects.toThrow();
  }

  expect(f.requests).toHaveLength(0);
});
