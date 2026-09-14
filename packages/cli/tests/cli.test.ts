import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCredentials } from "../src/infra/config/credentials";
import { FileVault } from "../src/infra/fs/vault-adapter";
import { SqliteStore } from "../src/infra/storage/sqlite-store";
import { lockVault } from "../src/infra/storage/vault-lock";
import { configure } from "../src/usecase/configure";

const directories: string[] = [];

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "cf-sync-cli-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CLI persistence and filesystem", () => {
  it("saves credentials privately and rejects incomplete environment overrides", async () => {
    const base = await temporary();
    const env = {
      XDG_CONFIG_HOME: base,
      CF_ACCESS_CLIENT_ID: "id",
      CF_ACCESS_CLIENT_SECRET: "secret",
    };
    await configure("https://sync.example", env);
    expect(await resolveCredentials("https://sync.example", { XDG_CONFIG_HOME: base })).toEqual({
      clientId: "id",
      clientSecret: "secret",
    });
    expect((await stat(join(base, "obsidian-cf-sync/config.json"))).mode & 0o777).toBe(0o600);
    await expect(
      resolveCredentials("https://sync.example", {
        XDG_CONFIG_HOME: base,
        CF_ACCESS_CLIENT_ID: "override",
      }),
    ).rejects.toThrow();
  });

  it("rejects symlinks and traversal without editing files outside the Vault", async () => {
    const root = await temporary();
    const outside = await temporary();
    await writeFile(join(outside, "note.md"), "outside");
    await symlink(outside, join(root, "linked"));
    const vault = new FileVault(root);
    await expect(vault.write("linked/note.md", Buffer.from("changed"))).rejects.toThrow(
      "Symbolic link",
    );
    await expect(vault.remove("../note.md")).rejects.toThrow("Unsafe");
    await expect(vault.list()).rejects.toThrow("Symbolic link");
    expect(await readFile(join(outside, "note.md"), "utf8")).toBe("outside");
  });

  it("excludes metadata and preserves binary files", async () => {
    const root = await temporary();
    await mkdir(join(root, ".cf-sync"));
    await writeFile(join(root, ".cf-sync/vault.json"), "{}");
    const vault = new FileVault(root);
    const bytes = new Uint8Array([0, 255, 7]);
    await vault.write("assets/image.bin", bytes);
    expect(await vault.list()).toEqual(["assets/image.bin"]);
    expect(new Uint8Array(await vault.read("assets/image.bin"))).toEqual(bytes);
    await expect(vault.write(".cf-sync/vault.json", bytes)).rejects.toThrow();
  });

  it("rejects a second lock and allows a later invocation", async () => {
    const root = await temporary();
    const release = await lockVault(root);
    await expect(lockVault(root)).rejects.toThrow("Another process");
    await release();
    await (
      await lockVault(root)
    )();
  });

  it("persists document data across store instances", async () => {
    const path = join(await temporary(), "state.sqlite");
    const first = new SqliteStore(path);
    await first.put("document", new Uint8Array([1, 2, 3]));
    first.close();
    const second = new SqliteStore(path);
    expect(await second.get("document")).toEqual(new Uint8Array([1, 2, 3]));
    second.close();
  });

  it("isolates dry-run store writes from the persisted database", async () => {
    const path = join(await temporary(), "state.sqlite");
    const source = new SqliteStore(path);
    await source.put("document", new Uint8Array([1]));
    const plan = new SqliteStore(path, true);
    expect(await plan.get("document")).toEqual(new Uint8Array([1]));
    await plan.put("document", new Uint8Array([2]));
    plan.close();
    expect(await source.get("document")).toEqual(new Uint8Array([1]));
    source.close();
  });
});
