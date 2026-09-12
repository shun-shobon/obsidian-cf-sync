import { PluginSettingTab, Setting, type App } from "obsidian";

import { pathSchema } from "../../shared/protocol";
import { serverOrigin } from "../auth/oauth";
import type CFSyncPlugin from "../main";

import { statusText } from "./status";
export class SyncSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: CFSyncPlugin,
  ) {
    super(app, plugin);
  }
  override display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "CF Sync" });
    let server = this.plugin.config.server;
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
          void this.plugin.run(async () => {
            await this.plugin.changeServer(serverOrigin(server));
            this.display();
          });
        }),
      );
    new Setting(containerEl).setName("端末名").addText((t) =>
      t.setValue(this.plugin.config.deviceName).onChange((v) => {
        this.plugin.config.deviceName = v;
        void this.plugin.run(() => this.plugin.persist());
      }),
    );
    new Setting(containerEl)
      .setName("認証")
      .setDesc(
        "トークンはこの端末のプラグイン data.json に保存されます。このファイルを共有しないでください。",
      )
      .addButton((b) =>
        b.setButtonText("ブラウザでログイン").onClick(() => {
          void this.plugin.run(() => this.plugin.login());
        }),
      )
      .addButton((b) =>
        b.setButtonText("ログアウト").onClick(() => {
          void this.plugin.run(() => this.plugin.logout());
        }),
      );
    new Setting(containerEl)
      .setName("同期を一時停止")
      .addToggle((t) =>
        t
          .setValue(this.plugin.config.paused)
          .onChange((v) => this.plugin.run(() => this.plugin.setPaused(v))),
      );
    new Setting(containerEl)
      .setName("同期状態")
      .setDesc(this.plugin.status ? statusText(this.plugin.status) : "未接続")
      .addButton((b) =>
        b.setButtonText("今すぐ同期").onClick(() => {
          void this.plugin.run(async () => {
            await this.plugin.engine?.syncNow();
            this.display();
          });
        }),
      );
    if (this.plugin.config.server && this.plugin.config.auth.tokens)
      void this.plugin.run(() => this.loadRemote());
  }
  private async loadRemote() {
    const api = this.plugin.api();
    const [vaults, devices] = await Promise.all([api.vaults(), api.devices()]);
    const remote = this.containerEl.createDiv();
    new Setting(remote)
      .setName("接続先 Vault")
      .setDesc(
        "一度接続したローカル Vault の接続先変更はできません。別 Vault には別のローカル Vault を使用してください。",
      )
      .addDropdown((d) => {
        d.addOption("", "選択してください");
        for (const vault of vaults) d.addOption(vault.id, vault.name);
        d.setValue(this.plugin.config.vaultId);
        d.setDisabled(Boolean(this.plugin.config.vaultId));
        d.onChange((id) =>
          this.plugin.run(async () => {
            if (!id) return;
            this.plugin.config.vaultId = id;
            await this.plugin.persist();
            await this.plugin.connect();
            this.display();
          }),
        );
      });
    let name = "";
    new Setting(remote)
      .setName("サーバーに Vault を作成")
      .addText((t) =>
        t.onChange((v) => {
          name = v.trim();
        }),
      )
      .addButton((b) =>
        b.setButtonText("作成").onClick(() => {
          void this.plugin.run(async () => {
            if (!name) throw new Error("Vault 名を入力してください");
            await api.createVault(name);
            this.display();
          });
        }),
      );
    remote.createEl("h3", { text: "端末" });
    for (const device of devices)
      new Setting(remote)
        .setName(device.name)
        .setDesc(`${device.id}${device.revoked ? " / 失効済み" : ""}`)
        .addButton((b) =>
          b
            .setButtonText("失効")
            .setDisabled(device.revoked)
            .onClick(() => {
              void this.plugin.run(async () => {
                await api.revokeDevice(device.id);
                if (device.id === this.plugin.config.deviceId) await this.plugin.logout();
                this.display();
              });
            }),
        );
    if (!this.plugin.config.vaultId) return;
    const snapshot = await api.snapshot();
    let exclusions = snapshot.exclusions.join("\n");
    new Setting(remote)
      .setName("除外パス")
      .setDesc("1 行に 1 パス。フォルダー以下も対象です。ワイルドカードは使えません。")
      .addTextArea((t) =>
        t.setValue(exclusions).onChange((v) => {
          exclusions = v;
        }),
      )
      .addButton((b) =>
        b.setButtonText("保存").onClick(() => {
          void this.plugin.run(async () => {
            const paths = exclusions
              .split("\n")
              .map((p) => p.trim())
              .filter(Boolean)
              .map((p) => pathSchema.parse(p));
            await api.exclusions(paths);
            await this.plugin.engine?.syncNow();
            this.display();
          });
        }),
      );
    remote.createEl("h3", { text: "競合ファイル" });
    for (const file of snapshot.files.filter((file) => file.conflict))
      new Setting(remote).setName(file.path).addButton((b) =>
        b.setButtonText("開く").onClick(() => {
          void this.app.workspace.openLinkText(file.path, "");
        }),
      );
  }
}
