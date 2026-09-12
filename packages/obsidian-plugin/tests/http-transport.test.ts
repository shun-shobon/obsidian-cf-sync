import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { requestUrl } from "obsidian";

import { obsidianTransport } from "../src/infra/obsidian/http-transport";

describe("Obsidian HTTP transport", () => {
  it("preserves a 401 response and its OAuth discovery challenge", async () => {
    const url = "https://sync.example.com/api";
    const resourceMetadataUrl =
      "https://sync.example.com/.well-known/cloudflare-access-protected-resource/api";
    const headers = { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` };
    const text = '{"error":"unauthorized"}';
    const arrayBuffer = new TextEncoder().encode(text).buffer;
    const response = { status: 401, headers, text, arrayBuffer, json: { error: "unauthorized" } };
    const request = { url, method: "GET", headers: { Accept: "application/json" } };
    vi.mocked(requestUrl).mockReturnValueOnce(
      Object.assign(Promise.resolve(response), {
        text: Promise.resolve(text),
        json: Promise.resolve(response.json),
        arrayBuffer: Promise.resolve(arrayBuffer),
      }),
    );

    const result = await obsidianTransport(request);

    expect(requestUrl).toHaveBeenCalledExactlyOnceWith({ ...request, throw: false });
    expect(result).toEqual({ status: 401, headers, text, bytes: arrayBuffer });
  });
});
