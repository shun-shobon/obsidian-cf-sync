import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";

import { serverOrigin } from "../domain/server-origin";

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
      .setName("サーバー URL")
      .setDesc("HTTPS のオリジンを指定します。")
      .addText((t) =>
        t
          .setValue(server)
          .setPlaceholder("https://sync.example.com")
          .onChange((v) => {
            server = v.trim();
          }),
      )
      .addButton((b) =>
        b.setButtonText("保存").onClick(() => {
          void this.controller.run(async () => {
            await this.controller.changeServer(serverOrigin(server));
            this.display();
          });
        }),
      );
    new Setting(containerEl).setName("端末名").addText((t) =>
      t.setValue(this.controller.config.deviceName).onChange((v) => {
        void this.controller.run(() => this.controller.setDeviceName(v));
      }),
    );
  }

  private renderAuthenticationSettings() {
    const containerEl = this.containerEl;
    new Setting(containerEl)
      .setName("認証")
      .setDesc(
        "トークンはこの端末のプラグイン data.json に保存されます。このファイルを共有しないでください。",
      )
      .addButton((b) =>
        b.setButtonText("ブラウザでログイン").onClick(() => {
          void this.controller.run(() => this.controller.login());
        }),
      )
      .addButton((b) =>
        b.setButtonText("ログアウト").onClick(() => {
          void this.controller.run(() => this.controller.logout());
        }),
      );
  }

  private renderSyncSettings() {
    const containerEl = this.containerEl;
    new Setting(containerEl)
      .setName("同期を一時停止")
      .addToggle((t) =>
        t
          .setValue(this.controller.config.paused)
          .onChange((v) => this.controller.run(() => this.controller.setPaused(v))),
      );
    new Setting(containerEl)
      .setName("同期状態")
      .setDesc(this.controller.status ? statusText(this.controller.status) : "未接続")
      .addButton((b) =>
        b.setButtonText("今すぐ同期").onClick(() => {
          void this.controller.run(async () => {
            await this.controller.engine?.syncNow();
            this.display();
          });
        }),
      );
  }
}
