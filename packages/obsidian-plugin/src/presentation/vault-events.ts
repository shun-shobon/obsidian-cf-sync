import { TFile, TFolder, type Plugin, type TAbstractFile } from "obsidian";

import type { PluginController } from "./plugin-controller";

function descendantPaths(file: TAbstractFile): string[] {
  if (file instanceof TFile) return [file.path];
  if (file instanceof TFolder) return file.children.flatMap(descendantPaths);

  return [];
}

async function captureFile(
  controller: PluginController,
  file: TAbstractFile,
  type: "create" | "modify",
) {
  if (!(file instanceof TFile)) return;
  const path = file.path;
  if (!(await controller.vault.isOwnEvent({ type, file, path }))) {
    await controller.engine?.capture(path);
  }
}

async function captureDelete(controller: PluginController, file: TAbstractFile) {
  if (
    file instanceof TFile &&
    (await controller.vault.isOwnEvent({ type: "delete", file, path: file.path }))
  )
    return;
  for (const path of descendantPaths(file)) await controller.engine?.captureDelete(path);
}

async function captureRename(
  plugin: Plugin,
  controller: PluginController,
  file: TAbstractFile,
  oldPath: string,
) {
  const path = file.path;
  if (file instanceof TFile) {
    if (!(await controller.vault.isOwnEvent({ type: "rename", file, path, oldPath }))) {
      await controller.engine?.captureRename(oldPath, path);
    }
    return;
  }
  const children = plugin.app.vault.getFiles().filter((child) => child.path.startsWith(`${path}/`));
  for (const child of children) {
    await controller.engine?.captureRename(oldPath + child.path.slice(path.length), child.path);
  }
}

export function registerVaultEvents(plugin: Plugin, controller: PluginController) {
  const vault = plugin.app.vault;
  plugin.registerEvent(
    vault.on("create", (file) => {
      void controller.run(() => captureFile(controller, file, "create"));
    }),
  );
  plugin.registerEvent(
    vault.on("modify", (file) => {
      void controller.run(() => captureFile(controller, file, "modify"));
    }),
  );
  plugin.registerEvent(
    vault.on("delete", (file) => {
      void controller.run(() => captureDelete(controller, file));
    }),
  );
  plugin.registerEvent(
    vault.on("rename", (file, oldPath) => {
      void controller.run(() => captureRename(plugin, controller, file, oldPath));
    }),
  );
}
