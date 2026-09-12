import type { Device, Snapshot, VaultInfo } from "@cf-sync/protocol";
import { Setting, type App } from "obsidian";

import { t } from "../../i18n";
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

  if (!controller.config.vaultId) {
    return;
  }

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
    .setName(t(($) => $.ui.remoteVault))
    .setDesc(t(($) => $.ui.remoteVaultDescription))
    .addDropdown((dropdown) => {
      dropdown.addOption(
        "",
        t(($) => $.ui.selectVault),
      );

      for (const vault of vaults) {
        dropdown.addOption(vault.id, vault.name);
      }

      dropdown.setValue(controller.config.vaultId);
      dropdown.setDisabled(Boolean(controller.config.vaultId));
      dropdown.onChange((id) =>
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
    .setName(t(($) => $.ui.createRemoteVault))
    .addText((input) =>
      input.onChange((value) => {
        name = value.trim();
      }),
    )
    .addButton((button) =>
      button.setButtonText(t(($) => $.ui.create)).onClick(() => {
        void controller.run(async () => {
          if (!name) {
            throw new Error(t(($) => $.ui.vaultNameRequired));
          }

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
  remote.createEl("h3", { text: t(($) => $.ui.devices) });

  for (const device of devices) {
    let description = device.id;

    if (device.revoked) {
      description += ` / ${t(($) => $.ui.revoked)}`;
    }

    new Setting(remote)
      .setName(device.name)
      .setDesc(description)
      .addButton((button) =>
        button
          .setButtonText(t(($) => $.ui.revoke))
          .setDisabled(device.revoked)
          .onClick(() => {
            void controller.run(async () => {
              await controller.revokeDevice(device.id);
              refresh();
            });
          }),
      );
  }
}

function renderExclusions(
  remote: HTMLElement,
  controller: PluginController,
  refresh: () => void,
  snapshot: Snapshot,
) {
  let exclusions = snapshot.exclusions.join("\n");
  new Setting(remote)
    .setName(t(($) => $.ui.excludedPaths))
    .setDesc(t(($) => $.ui.excludedPathsDescription))
    .addTextArea((input) =>
      input.setValue(exclusions).onChange((value) => {
        exclusions = value;
      }),
    )
    .addButton((button) =>
      button.setButtonText(t(($) => $.ui.save)).onClick(() => {
        void controller.run(async () => {
          const paths = exclusions
            .split("\n")
            .map((path) => path.trim())
            .filter(Boolean);
          await controller.saveExclusions(paths);
          refresh();
        });
      }),
    );
}

function renderConflicts(remote: HTMLElement, app: App, snapshot: Snapshot) {
  remote.createEl("h3", { text: t(($) => $.ui.conflictFiles) });

  for (const file of snapshot.files.filter((file) => file.conflict)) {
    new Setting(remote).setName(file.path).addButton((button) =>
      button.setButtonText(t(($) => $.ui.open)).onClick(() => {
        void app.workspace.openLinkText(file.path, "");
      }),
    );
  }
}
