import type { Device, Snapshot, VaultInfo } from "@cf-sync/protocol";
import { Setting, type App } from "obsidian";

import type { ApiClient } from "../../infra/http/api-client";
import type { PluginController } from "../plugin-controller";

export async function renderRemoteSettings(
  container: HTMLElement,
  app: App,
  controller: PluginController,
  refresh: () => void,
) {
  const api = controller.api();
  const [vaults, devices] = await Promise.all([api.vaults(), api.devices()]);
  const remote = container.createDiv();
  renderVaultSelection(remote, controller, refresh, vaults);
  renderCreateVault(remote, controller, refresh, api);
  renderDevices(remote, controller, refresh, devices);
  if (!controller.config.vaultId) return;
  const snapshot = await api.snapshot();
  renderExclusions(remote, controller, refresh, snapshot);
  renderConflicts(remote, app, snapshot);
}

function renderVaultSelection(
  remote: HTMLElement,
  controller: PluginController,
  refresh: () => void,
  vaults: VaultInfo[],
) {
  new Setting(remote)
    .setName("接続先 Vault")
    .setDesc(
      "一度接続したローカル Vault の接続先変更はできません。別 Vault には別のローカル Vault を使用してください。",
    )
    .addDropdown((d) => {
      d.addOption("", "選択してください");
      for (const vault of vaults) d.addOption(vault.id, vault.name);
      d.setValue(controller.config.vaultId);
      d.setDisabled(Boolean(controller.config.vaultId));
      d.onChange((id) =>
        controller.run(async () => {
          await controller.selectVault(id);
          refresh();
        }),
      );
    });
}

function renderCreateVault(
  remote: HTMLElement,
  controller: PluginController,
  refresh: () => void,
  api: ApiClient,
) {
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
        void controller.run(async () => {
          if (!name) throw new Error("Vault 名を入力してください");
          await api.createVault(name);
          refresh();
        });
      }),
    );
}

function renderDevices(
  remote: HTMLElement,
  controller: PluginController,
  refresh: () => void,
  devices: Device[],
) {
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
            void controller.run(async () => {
              await controller.revokeDevice(device.id);
              refresh();
            });
          }),
      );
}

function renderExclusions(
  remote: HTMLElement,
  controller: PluginController,
  refresh: () => void,
  snapshot: Snapshot,
) {
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
        void controller.run(async () => {
          const paths = exclusions
            .split("\n")
            .map((p) => p.trim())
            .filter(Boolean);
          await controller.saveExclusions(paths);
          refresh();
        });
      }),
    );
}

function renderConflicts(remote: HTMLElement, app: App, snapshot: Snapshot) {
  remote.createEl("h3", { text: "競合ファイル" });
  for (const file of snapshot.files.filter((file) => file.conflict))
    new Setting(remote).setName(file.path).addButton((b) =>
      b.setButtonText("開く").onClick(() => {
        void app.workspace.openLinkText(file.path, "");
      }),
    );
}
