import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";

import { serverOrigin } from "../domain/server-origin";
import { t } from "../i18n";

import type { PluginController } from "./plugin-controller";
import { renderRemoteSettings } from "./settings/remote-settings";
import { statusText } from "./status";

export class SyncSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly controller: PluginController,
  ) {
    super(app, plugin);
  }

  override display() {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "CF Sync" });
    this.renderServerSettings();
    this.renderAuthenticationSettings();
    this.renderSyncSettings();

    if (this.controller.config.server && this.controller.config.auth.tokens) {
      void this.controller.run(() =>
        renderRemoteSettings(this.containerEl, this.app, this.controller, () => this.display()),
      );
    }
  }

  private renderServerSettings() {
    const containerEl = this.containerEl;
    let server = this.controller.config.server;
    new Setting(containerEl)
      .setName(t(($) => $.ui.serverUrl))
      .setDesc(t(($) => $.ui.serverUrlDescription))
      .addText((input) =>
        input
          .setValue(server)
          .setPlaceholder("https://sync.example.com")
          .onChange((value) => {
            server = value.trim();
          }),
      )
      .addButton((button) =>
        button.setButtonText(t(($) => $.ui.save)).onClick(() => {
          void this.controller.run(async () => {
            await this.controller.changeServer(serverOrigin(server));
            this.display();
          });
        }),
      );
    new Setting(containerEl).setName(t(($) => $.ui.deviceName)).addText((input) =>
      input.setValue(this.controller.config.deviceName).onChange((value) => {
        void this.controller.run(() => this.controller.setDeviceName(value));
      }),
    );
  }

  private renderAuthenticationSettings() {
    const containerEl = this.containerEl;
    new Setting(containerEl)
      .setName(t(($) => $.ui.authentication))
      .setDesc(t(($) => $.ui.authenticationDescription))
      .addButton((button) =>
        button.setButtonText(t(($) => $.ui.loginInBrowser)).onClick(() => {
          void this.controller.run(() => this.controller.login());
        }),
      )
      .addButton((button) =>
        button.setButtonText(t(($) => $.ui.logout)).onClick(() => {
          void this.controller.run(() => this.controller.logout());
        }),
      );
  }

  private renderSyncSettings() {
    const containerEl = this.containerEl;
    let description: string = t(($) => $.ui.disconnected);

    if (this.controller.status) {
      description = statusText(this.controller.status);
    }

    new Setting(containerEl)
      .setName(t(($) => $.ui.pauseSync))
      .addToggle((input) =>
        input
          .setValue(this.controller.config.paused)
          .onChange((value) => this.controller.run(() => this.controller.setPaused(value))),
      );
    new Setting(containerEl)
      .setName(t(($) => $.ui.syncStatus))
      .setDesc(description)
      .addButton((button) =>
        button.setButtonText(t(($) => $.ui.syncNow)).onClick(() => {
          void this.controller.run(async () => {
            await this.controller.engine?.syncNow();
            this.display();
          });
        }),
      );
  }
}
