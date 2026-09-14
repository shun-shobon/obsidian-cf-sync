import * as v from "valibot";

import { credentialsSchema, type Credentials } from "../../domain/credentials";

import { readConfig } from "./config-file";

export function requireEnvironmentCredentials(env: NodeJS.ProcessEnv): Credentials {
  return v.parse(credentialsSchema, {
    clientId: env["CF_ACCESS_CLIENT_ID"],
    clientSecret: env["CF_ACCESS_CLIENT_SECRET"],
  });
}

export function readEnvironmentCredentials(env: NodeJS.ProcessEnv): Credentials | undefined {
  const hasClientId = env["CF_ACCESS_CLIENT_ID"] !== undefined;
  const hasClientSecret = env["CF_ACCESS_CLIENT_SECRET"] !== undefined;

  if (!hasClientId && !hasClientSecret) {
    return undefined;
  }

  return requireEnvironmentCredentials(env);
}

export async function resolveCredentials(
  origin: string,
  env: NodeJS.ProcessEnv,
): Promise<Credentials> {
  const environmentCredentials = readEnvironmentCredentials(env);

  if (environmentCredentials) {
    return environmentCredentials;
  }

  const config = await readConfig(env);
  const stored = config[origin];

  if (!stored) {
    throw new Error(
      "Service Token is missing. Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, then run config",
    );
  }

  return stored;
}
