import type { Plugin } from "obsidian";

import { t } from "../i18n";

import type { PluginController } from "./plugin-controller";

export function registerCommands(plugin: Plugin, controller: PluginController) {
  plugin.addCommand({
    id: "sync-now",
    name: t(($) => $.ui.syncNow),
    callback: () => {
      void controller.run(() => controller.syncNow());
    },
  });
  plugin.addCommand({
    id: "toggle-pause",
    name: t(($) => $.ui.togglePause),
    callback: () => {
      void controller.run(() => controller.setPaused(!controller.config.paused));
    },
  });
}
