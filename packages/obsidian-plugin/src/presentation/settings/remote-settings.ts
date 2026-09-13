import type { Device, Snapshot, VaultInfo } from "@cf-sync/protocol";
import { Setting, type App, type SettingDefinitionItem } from "obsidian";

import { t } from "../../i18n";
import type { ApiClient } from "../../infra/http/api-client";
import type { PluginController } from "../plugin-controller";

export function remoteSettingDefinitions(
  app: App,
  controller: PluginController,
  refresh: () => void,
): SettingDefinitionItem[] {
  const definitions: SettingDefinitionItem[] = [
    {
      name: t(($) => $.ui.remoteVault),
      desc: t(($) => $.ui.remoteVaultDescription),
      render: (setting) =>
        renderAsync(
          controller,
          () => controller.api().vaults(),
          (vaults) => renderVaultSelection(setting, controller, refresh, vaults),
        ),
    },
    {
      name: t(($) => $.ui.createRemoteVault),
      render: (setting) => renderCreateVault(setting, controller, refresh, controller.api()),
    },
    {
      name: t(($) => $.ui.devices),
      render: (setting) =>
        renderRows(
          setting,
          controller,
          () => controller.api().devices(),
          (container, devices) => renderDevices(container, controller, refresh, devices),
        ),
    },
  ];

  if (controller.config.vaultId) {
    definitions.push(...snapshotSettingDefinitions(app, controller, refresh));
  }

  return definitions;
}

function snapshotSettingDefinitions(
  app: App,
  controller: PluginController,
  refresh: () => void,
): SettingDefinitionItem[] {
  let snapshot: Promise<Snapshot> | undefined;
  const loadSnapshot = () => {
    snapshot ??= controller
      .api()
      .snapshot()
      .finally(() => {
        snapshot = undefined;
      });
    return snapshot;
  };
  return [
    {
      name: t(($) => $.ui.excludedPaths),
      desc: t(($) => $.ui.excludedPathsDescription),
      render: (setting) =>
        renderAsync(controller, loadSnapshot, (value) =>
          renderExclusions(setting, controller, refresh, value),
        ),
    },
    {
      name: t(($) => $.ui.conflictFiles),
      render: (setting) =>
        renderRows(setting, controller, loadSnapshot, (container, value) =>
          renderConflicts(container, app, value),
        ),
    },
  ];
}

function renderAsync<T>(
  controller: PluginController,
  load: () => Promise<T>,
  render: (value: T) => void,
): () => void {
  let active = true;
  void controller.run(async () => {
    const value = await load();
    if (active) {
      render(value);
    }
  });
  return () => {
    active = false;
  };
}

function renderRows<T>(
  setting: Setting,
  controller: PluginController,
  load: () => Promise<T>,
  render: (container: HTMLElement, value: T) => void,
): () => void {
  setting.setHeading();
  const container = setting.settingEl.ownerDocument.createElement("div");
  setting.settingEl.after(container);
  const cleanup = renderAsync(controller, load, (value) => render(container, value));
  return () => {
    cleanup();
    container.remove();
  };
}

function renderVaultSelection(
  setting: Setting,
  controller: PluginController,
  refresh: () => void,
  vaults: VaultInfo[],
) {
  setting.addDropdown((dropdown) => {
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
  setting: Setting,
  controller: PluginController,
  refresh: () => void,
  api: ApiClient,
) {
  let name = "";
  setting
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
  setting: Setting,
  controller: PluginController,
  refresh: () => void,
  snapshot: Snapshot,
) {
  let exclusions = snapshot.exclusions.join("\n");
  setting
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
  for (const file of snapshot.files.filter((file) => file.conflict)) {
    new Setting(remote).setName(file.path).addButton((button) =>
      button.setButtonText(t(($) => $.ui.open)).onClick(() => {
        void app.workspace.openLinkText(file.path, "");
      }),
    );
  }
}
