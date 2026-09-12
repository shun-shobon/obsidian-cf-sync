import { describe, expect, it } from "vitest";

import { discoverAuthorizationServer } from "../src/infra/auth/oauth-discovery";
import type { HttpRequest, HttpResponse, Transport } from "../src/infra/http/transport";

const origin = "https://sync.example.com";
const resource = `${origin}/api`;
const resourceMetadataUrl = `${origin}/.well-known/cloudflare-access-protected-resource/api`;
const issuer = "https://team.cloudflareaccess.com";
const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
};

function jsonResponse(value: unknown): HttpResponse {
  return { status: 200, headers: {}, text: JSON.stringify(value), bytes: new ArrayBuffer(0) };
}

function setup() {
  const requests: HttpRequest[] = [];
  const challenge: HttpResponse = {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
    },
    text: "",
    bytes: new ArrayBuffer(0),
  };
  const responses = new Map<string, HttpResponse>([
    [resource, challenge],
    [resourceMetadataUrl, jsonResponse({ resource, authorization_servers: [issuer] })],
    [metadataUrl, jsonResponse(metadata)],
  ]);
  const transport: Transport = async (request) => {
    requests.push(request);
    const response = responses.get(request.url);

    if (!response) {
      throw new Error(`Unexpected discovery request: ${request.url}`);
    }

    return response;
  };

  return { requests, challenge, responses, transport };
}

describe("Cloudflare Access OAuth discovery", () => {
  it("follows the protected API challenge to the team authorization server", async () => {
    const { transport, requests } = setup();
    const discovered = await discoverAuthorizationServer(origin, transport);

    expect(discovered).toEqual({ resource, metadata });
    expect(requests.map((request) => request.url)).toEqual([
      resource,
      resourceMetadataUrl,
      metadataUrl,
    ]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.headers?.["Authorization"] === undefined)).toBe(
      true,
    );
  });

  it.each([
    ["www-authenticate", `bearer RESOURCE_METADATA="${resourceMetadataUrl}"`],
    ["WwW-AuThEnTiCaTe", `Bearer resource_metadata="${resourceMetadataUrl}"`],
    ["WWW-Authenticate", `Bearer realm="sync, notes", resource_metadata="${resourceMetadataUrl}"`],
  ])("recognizes case-insensitive headers and quoted commas: %s %s", async (name, value) => {
    const { transport, challenge } = setup();
    challenge.headers = { [name]: value };

    await expect(discoverAuthorizationServer(origin, transport)).resolves.toEqual({
      resource,
      metadata,
    });
  });

  it.each([200, 302, 403, 500])(
    "stops when the API does not return a 401 challenge: %s",
    async (status) => {
      const { transport, challenge, requests } = setup();
      challenge.status = status;

      await expect(discoverAuthorizationServer(origin, transport)).rejects.toThrow();
      expect(requests).toHaveLength(1);
    },
  );

  it.each<Record<string, string>>([
    {},
    { "WWW-Authenticate": 'Bearer realm="sync"' },
    { "WWW-Authenticate": `Basic resource_metadata="${resourceMetadataUrl}"` },
  ])("rejects missing Bearer resource metadata: %j", async (headers) => {
    const { transport, challenge, requests } = setup();
    challenge.headers = headers;

    await expect(discoverAuthorizationServer(origin, transport)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it.each([
    `Basic realm="legacy", Bearer resource_metadata="${resourceMetadataUrl}"`,
    `Bearer resource_metadata="${resourceMetadataUrl}", Basic realm="legacy"`,
  ])("rejects unsupported combined challenges: %s", async (header) => {
    const { transport, challenge, requests } = setup();
    challenge.headers = { "WWW-Authenticate": header };

    await expect(discoverAuthorizationServer(origin, transport)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("rejects a resource document for a different API", async () => {
    const { transport, responses, requests } = setup();
    responses.set(
      resourceMetadataUrl,
      jsonResponse({
        resource: "https://other.example.com/api",
        authorization_servers: [issuer],
      }),
    );

    await expect(discoverAuthorizationServer(origin, transport)).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it.each([{}, { authorization_servers: [] }])(
    "requires an authorization server: %j",
    async (fields) => {
      const { transport, responses, requests } = setup();
      responses.set(resourceMetadataUrl, jsonResponse({ resource, ...fields }));

      await expect(discoverAuthorizationServer(origin, transport)).rejects.toThrow();
      expect(requests).toHaveLength(2);
    },
  );

  it("rejects an authorization server metadata issuer mismatch", async () => {
    const { transport, responses } = setup();
    responses.set(metadataUrl, jsonResponse({ ...metadata, issuer: "https://other.example.com" }));

    await expect(discoverAuthorizationServer(origin, transport)).rejects.toThrow();
  });

  it("rejects an HTTP metadata URL before following it", async () => {
    const { transport, challenge, requests } = setup();
    challenge.headers = {
      "WWW-Authenticate": 'Bearer resource_metadata="http://sync.example.com/metadata"',
    };

    await expect(discoverAuthorizationServer(origin, transport)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("rejects an HTTP authorization server before contacting it", async () => {
    const { transport, responses, requests } = setup();
    responses.set(
      resourceMetadataUrl,
      jsonResponse({
        resource,
        authorization_servers: ["http://team.cloudflareaccess.com"],
      }),
    );

    await expect(discoverAuthorizationServer(origin, transport)).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });
});
