import { defineCommand } from "citty";

import { initializeVault } from "../../usecase/initialize-vault";
import type { CliContext } from "../context";
import { writeOutput } from "../output";

export function createInitCommand(context: CliContext) {
  return defineCommand({
    meta: { name: "init", description: "Connect a directory to an existing Vault" },
    args: {
      directory: { type: "positional", description: "Local Vault directory", default: "." },
      server: { type: "string", description: "Server URL (or CF_SYNC_SERVER_URL)" },
      json: { type: "boolean", description: "Write a JSON result" },
      vault: { type: "string", required: true, description: "Remote Vault ID" },
    },
    async run({ args }) {
      const options = { directory: args.directory, server: args.server, vaultId: args.vault };
      const result = await initializeVault(options, context.env);

      writeOutput(context, args.json, result, `Connected ${result.directory} to ${result.vaultId}`);
    },
  });
}
