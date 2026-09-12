import { parse } from "auth-header";
import {
  customFetch,
  discoveryRequest,
  processDiscoveryResponse,
  processResourceDiscoveryResponse,
} from "oauth4webapi";
import * as v from "valibot";

import { httpsUrlSchema, metadataSchema } from "../../domain/auth-state";
import { AuthenticationError } from "../../domain/authentication-error";
import { t } from "../../i18n";
import type { HttpRequest, Transport } from "../http/transport";

const resourceSchema = v.object({
  resource: httpsUrlSchema,
  authorization_servers: v.pipe(v.array(httpsUrlSchema), v.length(1)),
});

async function requestResponse(transport: Transport, request: HttpRequest): Promise<Response> {
  const response = await transport(request);

  return new Response(response.text, { status: response.status, headers: response.headers });
}

function resourceMetadataUrl(response: Response): string {
  if (response.status !== 401) {
    throw new AuthenticationError(
      t(($) => $.errors.expectedUnauthorized, { status: response.status }),
    );
  }

  const header = response.headers.get("www-authenticate");
  if (!header) {
    throw new AuthenticationError(t(($) => $.errors.missingChallenge));
  }

  const challenge = parse(header);
  if (challenge.scheme.toLowerCase() !== "bearer" || challenge.token !== null) {
    throw new AuthenticationError(t(($) => $.errors.missingBearerMetadata));
  }

  const parameters = new Headers();
  for (const [name, value] of Object.entries(challenge.params)) {
    if (name.toLowerCase() === "resource_metadata") {
      parameters.append(name, v.parse(v.string(), value));
    }
  }

  return v.parse(httpsUrlSchema, parameters.get("resource_metadata"));
}

export async function discoverAuthorizationServer(origin: string, transport: Transport) {
  const resourceUrl = new URL("/api", origin);
  const challenge = await requestResponse(transport, {
    url: resourceUrl.href,
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const metadataUrl = resourceMetadataUrl(challenge);
  const resourceResponse = await requestResponse(transport, { url: metadataUrl, method: "GET" });
  const discoveredResource = await processResourceDiscoveryResponse(resourceUrl, resourceResponse);
  const resource = v.parse(resourceSchema, discoveredResource);

  const issuer = new URL(resource.authorization_servers[0]!);
  const response = await discoveryRequest(issuer, {
    algorithm: "oauth2",
    [customFetch]: async (url, options) =>
      requestResponse(transport, {
        url: String(url),
        method: "GET",
        headers: Object.fromEntries(new Headers(options.headers)),
      }),
  });
  const discoveredMetadata = await processDiscoveryResponse(issuer, response);
  const metadata = v.parse(metadataSchema, discoveredMetadata);

  return { metadata, resource: resource.resource };
}
