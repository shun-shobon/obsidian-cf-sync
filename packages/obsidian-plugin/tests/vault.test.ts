import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  TFile: class {
    constructor(public path: string) {}
  },
}));
import { TFile, type FileManager, type Vault } from "obsidian";

import { ObsidianVault } from "../src/infra/obsidian/vault-adapter";

const encode = (text: string) => new TextEncoder().encode(text);
type Event =
  | { type: "create" | "modify" | "delete"; file: TFile; path: string }
  | { type: "rename"; file: TFile; path: string; oldPath: string };
function fixture(delayed: boolean) {
  const files = new Map<string, TFile>();
  const contents = new Map<TFile, Uint8Array>();
  const folders: string[] = [];
  const deferred: Array<() => void> = [];
  const pending: Promise<void>[] = [];
  const forwarded: Event[] = [];
  let adapter: ObsidianVault;
  function emit(event: Event) {
    const deliver = () => {
      pending.push(
        adapter.isOwnEvent({ ...event, path: event.file.path }).then((own) => {
          if (!own) forwarded.push(event);
        }),
      );
    };
    if (delayed) deferred.push(deliver);
    else deliver();
  }
  const vault = {
    getFiles: () => [...files.values()],
    getAbstractFileByPath: (path: string) => files.get(path),
    readBinary: async (file: TFile) => new Uint8Array(contents.get(file)!).buffer,
    createFolder: async (path: string) => {
      folders.push(path);
    },
    createBinary: async (path: string, bytes: ArrayBuffer) => {
      const file = Object.assign(new TFile(), { path });
      files.set(path, file);
      contents.set(file, new Uint8Array(bytes));
      emit({ type: "create", file, path });
      return file;
    },
    modifyBinary: async (file: TFile, bytes: ArrayBuffer) => {
      contents.set(file, new Uint8Array(bytes));
      emit({ type: "modify", file, path: file.path });
    },
    rename: async (file: TFile, path: string) => {
      const oldPath = file.path;
      files.delete(oldPath);
      file.path = path;
      files.set(path, file);
      emit({ type: "rename", file, path, oldPath });
    },
    process: async (file: TFile, fn: (text: string) => string) => {
      const result = fn(new TextDecoder().decode(contents.get(file)));
      contents.set(file, encode(result));
      emit({ type: "modify", file, path: file.path });
      return result;
    },
  };
  const fileManager = {
    trashFile: vi.fn(async (file: TFile) => {
      files.delete(file.path);
      emit({ type: "delete", file, path: file.path });
    }),
  };
  adapter = new ObsidianVault(vault as unknown as Vault, fileManager as unknown as FileManager);
  return {
    adapter,
    fileManager,
    vault,
    files,
    contents,
    folders,
    forwarded,
    emit,
    flush: async () => {
      for (const deliver of deferred.splice(0)) deliver();
      await Promise.all(pending.splice(0));
    },
  };
}
describe("Obsidian Vault operation events", () => {
  for (const delayed of [false, true])
    it(`consumes own create/modify/rename/delete events (${delayed ? "delayed" : "synchronous"})`, async () => {
      const f = fixture(delayed);
      await f.adapter.write("note.md", encode("one"));
      await f.flush();
      await f.adapter.write("note.md", encode("two"));
      await f.flush();
      await f.adapter.rename("note.md", "renamed.md");
      await f.flush();
      const removedFile = f.files.get("renamed.md");
      await f.adapter.remove("renamed.md");
      expect(f.fileManager.trashFile).toHaveBeenCalledExactlyOnceWith(removedFile);
      await f.flush();
      expect(f.forwarded).toEqual([]);
      expect(f.folders).toEqual([]);
    });
  it("does not move the new occupant when a protective rename event arrives late", async () => {
    const f = fixture(true);
    await f.adapter.write("note.md", encode("local"));
    await f.flush();
    const original = f.files.get("note.md")!;
    await f.adapter.rename("note.md", "protected.md");
    await f.adapter.write("note.md", encode("remote"));
    await f.flush();
    expect(f.files.get("protected.md")).toBe(original);
    expect(f.files.get("note.md")).not.toBe(original);
    expect(f.forwarded).toEqual([]);
  });
  it("forwards an external content change while an own modify event is delayed", async () => {
    const f = fixture(true);
    await f.adapter.write("note.md", encode("base"));
    await f.flush();
    await f.adapter.write("note.md", encode("remote"));
    const file = f.files.get("note.md")!;
    f.contents.set(file, encode("external"));
    f.emit({ type: "modify", file, path: "note.md" });
    await f.flush();
    expect(f.forwarded.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(await f.adapter.read("note.md"))).toBe("external");
  });
  it("does not suppress an external rename after consuming its own rename", async () => {
    const f = fixture(true);
    await f.adapter.write("a.md", encode("x"));
    await f.flush();
    await f.adapter.rename("a.md", "b.md");
    await f.flush();
    const file = f.files.get("b.md")!;
    await f.vault.rename(file, "c.md");
    await f.flush();
    expect(f.forwarded).toEqual([{ type: "rename", file, path: "c.md", oldPath: "b.md" }]);
  });
  it("protects changed text through Vault.process and suppresses the successful CAS event", async () => {
    const f = fixture(true);
    await f.adapter.write("note.md", encode("external"));
    await f.flush();
    expect(await f.adapter.writeIfUnchanged("note.md", encode("old"), encode("remote"))).toBe(
      false,
    );
    await f.flush();
    expect(new TextDecoder().decode(await f.adapter.read("note.md"))).toBe("external");
    f.forwarded.length = 0;
    expect(await f.adapter.writeIfUnchanged("note.md", encode("external"), encode("remote"))).toBe(
      true,
    );
    await f.flush();
    expect(f.forwarded).toEqual([]);
  });
  it("matches a delayed own rename by file identity even after another rename", async () => {
    const f = fixture(true);
    await f.adapter.write("a.md", encode("x"));
    await f.flush();
    await f.adapter.rename("a.md", "b.md");
    const file = f.files.get("b.md")!;
    await f.vault.rename(file, "c.md");
    await f.flush();
    expect(f.forwarded).toEqual([{ type: "rename", file, path: "c.md", oldPath: "b.md" }]);
  });
  it("removes the expected event when an operation fails", async () => {
    const f = fixture(true);
    await f.adapter.write("a.md", encode("x"));
    await f.flush();
    const failure = vi.spyOn(f.vault, "rename").mockRejectedValueOnce(new Error("failure"));
    await expect(f.adapter.rename("a.md", "b.md")).rejects.toThrow("failure");
    failure.mockRestore();
    const file = f.files.get("a.md")!;
    await f.vault.rename(file, "b.md");
    await f.flush();
    expect(f.forwarded).toHaveLength(1);
  });
});
