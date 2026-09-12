import { toUint8Array, fromUint8Array } from "js-base64";
import { describe, expect, it } from "vitest";

import { conflictPath, digest, isExcluded, operationSchema, pathSchema } from "../src/index";

describe("portable paths and explicit exclusions", () => {
  it.each([
    "/absolute.md",
    "../secret",
    "a/../b",
    ".obsidian/config",
    "a//b",
    "CON.txt",
    "a/b.",
    "a\\b",
    "a:b",
  ])("rejects unsafe path %s", (path) => {
    expect(pathSchema.safeParse(path).success).toBe(false);
  });
  it("allows Unicode folders without treating sibling prefixes as excluded", () => {
    expect(pathSchema.parse("日記/九月.md")).toBe("日記/九月.md");
    expect(isExcluded("private/one.md", ["private"])).toBe(true);
    expect(isExcluded("private-other/one.md", ["private"])).toBe(false);
    expect(isExcluded("notes/.cache/value", [])).toBe(true);
  });
  it("preserves file extension in conflict paths", () => {
    expect(conflictPath("a.b/note.md", "123")).toBe("a.b/note (conflict 123).md");
    expect(conflictPath("a.b/note", "123")).toBe("a.b/note (conflict 123)");
  });
});
describe("wire encoding", () => {
  it("roundtrips binary beyond JS argument limits", () => {
    const bytes = new Uint8Array(300_000).map((_, index) => index % 256);
    expect(toUint8Array(fromUint8Array(bytes))).toEqual(bytes);
  });
  it("hashes actual bytes", async () => {
    expect(await digest(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("rejects malformed operation identities", () => {
    expect(
      operationSchema.safeParse({ type: "delete", fileId: "../../x", opId: "x", baseRevision: -1 })
        .success,
    ).toBe(false);
  });
});
