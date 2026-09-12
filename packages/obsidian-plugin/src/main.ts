import { Plugin } from "obsidian";
import * as v from "valibot";

import { initialSettings, settingsSchema, type Settings } from "./domain/plugin-settings";
import { registerCommands } from "./presentation/commands";
import { editorExtension } from "./presentation/editor/extension";
import { PluginController } from "./presentation/plugin-controller";
import { SyncSettingsTab } from "./presentation/settings-tab";
import { registerVaultEvents } from "./presentation/vault-events";

export default class CFSyncPlugin extends Plugin {
  private controller?: PluginController;

  override async onload() {
    const data: unknown = await this.loadData();
    let config: Settings;

    if (data === null) {
      config = initialSettings(this.app.vault.getName());
    } else {
      config = v.parse(settingsSchema, data);
    }

    const status = this.addStatusBarItem();
    status.setText("CF Sync: 未接続");
    const controller = new PluginController(
      this.app,
      config,
      (settings) => this.saveData(settings),
      (message) => status.setText(`CF Sync: ${message}`),
    );
    this.controller = controller;
    await controller.persist();

    this.addSettingTab(new SyncSettingsTab(this.app, this, controller));
    this.registerEditorExtension(
      editorExtension(
        () => controller.engine,
        (error) => controller.report(error),
      ),
    );

    registerCommands(this, controller);
    registerVaultEvents(this, controller);
    this.registerLifecycleEvents(controller);
  }

  private registerLifecycleEvents(controller: PluginController) {
    this.registerObsidianProtocolHandler("cf-sync-auth", (params) => {
      void controller.run(() => controller.finishLogin(params));
    });
    this.registerDomEvent(window, "online", () => {
      void controller.run(async () => {
        await controller.engine?.syncNow();
      });
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void controller.run(async () => {
          await controller.engine?.syncNow();
        });
      }
    });
    this.app.workspace.onLayoutReady(() => {
      void controller.run(() => controller.connect());
    });
  }

  override onunload() {
    this.controller?.dispose();
  }
}
