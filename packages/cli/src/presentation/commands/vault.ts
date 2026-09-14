import { defineCommand } from "citty";

import { listVaults } from "../../usecase/list-vaults";
import type { CliContext } from "../context";
import { writeOutput } from "../output";

export function createVaultCommand(context: CliContext) {
  const list = defineCommand({
    meta: { name: "list", description: "List existing remote Vaults" },
    args: {
      server: { type: "string", description: "Server URL (or CF_SYNC_SERVER_URL)" },
      json: { type: "boolean", description: "Write a JSON result" },
    },
    async run({ args }) {
      const result = await listVaults(args.server, context.env);
      const text = result.vaults.map((vault) => `${vault.id}\t${vault.name}`).join("\n");

      writeOutput(context, args.json, result, text);
    },
  });

  return defineCommand({
    meta: { name: "vault", description: "Manage the remote Vault connection" },
    subCommands: { list },
  });
}
