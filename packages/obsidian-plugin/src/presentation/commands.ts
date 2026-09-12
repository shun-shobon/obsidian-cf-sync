import type { Plugin } from "obsidian";

import type { PluginController } from "./plugin-controller";

export function registerCommands(plugin: Plugin, controller: PluginController) {
  plugin.addCommand({
    id: "sync-now",
    name: "今すぐ同期",
    callback: () => {
      void controller.run(() => controller.syncNow());
    },
  });
  plugin.addCommand({
    id: "toggle-pause",
    name: "同期の一時停止・再開",
    callback: () => {
      void controller.run(() => controller.setPaused(!controller.config.paused));
    },
  });
}
