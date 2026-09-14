import { defineCommand } from "citty";

import { synchronizeVault } from "../../usecase/synchronize-vault";
import type { CliContext } from "../context";
import { formatPlan, formatSyncResult, syncExitCode, writeOutput } from "../output";

export function createSyncCommand(context: CliContext) {
  return defineCommand({
    meta: { name: "sync", description: "Perform one bidirectional synchronization" },
    args: {
      directory: { type: "positional", description: "Local Vault directory", default: "." },
      json: { type: "boolean", description: "Write a JSON result" },
      "dry-run": { type: "boolean", description: "Show planned changes without applying them" },
    },
    async run({ args }) {
      const options = { directory: args.directory, dryRun: args["dry-run"] === true };
      const result = await synchronizeVault(options, context.env);

      if (result.mode === "plan") {
        writeOutput(context, args.json, { dryRun: true, ...result.plan }, formatPlan(result.plan));
        return;
      }

      writeOutput(context, args.json, result.sync, formatSyncResult(result.sync));
      context.exitCode = syncExitCode(result.sync);
    },
  });
}
