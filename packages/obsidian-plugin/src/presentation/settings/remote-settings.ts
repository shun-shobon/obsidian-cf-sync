import type { Device, Snapshot, VaultInfo } from "@cf-sync/protocol";
import type { App, Setting, SettingDefinitionItem, SettingGroupItem } from "obsidian";

import { t } from "../../i18n";
import type { PluginController } from "../plugin-controller";

/** Remote values cached across re-renders, because setting definitions are built synchronously. */
export class RemoteValue<T> {
	value: T | undefined;
	private loading: Promise<void> | undefined;

	constructor(private readonly load: () => Promise<T>) {}

	request(controller: PluginController, loaded: () => void): () => void {
		let active = true;
		this.loading ??= controller
			.run(async () => {
				this.value = await this.load();
			})
			.finally(() => {
				this.loading = undefined;
			});
		void this.loading.then(() => {
			if (active && this.value !== undefined) {
				loaded();
			}
		});

		return () => {
			active = false;
		};
	}

	clear(): void {
		this.value = undefined;
	}
}

export interface RemoteValues {
	devices: RemoteValue<Device[]>;
	snapshot: RemoteValue<Snapshot>;
}

export function remoteValues(controller: PluginController): RemoteValues {
	return {
		devices: new RemoteValue(() => controller.account().devices()),
		snapshot: new RemoteValue(() => controller.api().snapshot()),
	};
}

export function remoteSettingDefinitions(
	app: App,
	controller: PluginController,
	values: RemoteValues,
	refresh: () => void,
	update: () => void,
): SettingDefinitionItem[] {
	const definitions: SettingDefinitionItem[] = [
		{
			name: t(($) => $.ui.remoteVault),
			desc: t(($) => $.ui.remoteVaultDescription),
			render: (setting) =>
				renderAsync(
					controller,
					() => controller.account().vaults(),
					(vaults) => renderVaultSelection(setting, controller, refresh, vaults),
				),
		},
		{
			name: t(($) => $.ui.createRemoteVault),
			render: (setting) => renderCreateVault(setting, controller, refresh),
		},
		{
			type: "list",
			heading: t(($) => $.ui.devices),
			items: remoteItems(controller, values.devices, update, (devices) =>
				devices.map((device) => deviceItem(device, controller, refresh)),
			),
		},
	];

	if (controller.config.vaultId) {
		definitions.push(
			...snapshotSettingDefinitions(app, controller, values.snapshot, refresh, update),
		);
	}

	return definitions;
}

function snapshotSettingDefinitions(
	app: App,
	controller: PluginController,
	snapshot: RemoteValue<Snapshot>,
	refresh: () => void,
	update: () => void,
): SettingDefinitionItem[] {
	return [
		{
			name: t(($) => $.ui.excludedPaths),
			desc: t(($) => $.ui.excludedPathsDescription),
			render: (setting) => {
				if (snapshot.value === undefined) {
					return snapshot.request(controller, update);
				}

				renderExclusions(setting, controller, refresh, snapshot.value);
				return undefined;
			},
		},
		{
			type: "list",
			heading: t(($) => $.ui.conflictFiles),
			emptyState: t(($) => $.ui.noConflictFiles),
			items: remoteItems(controller, snapshot, update, (value) =>
				value.files.filter((file) => file.conflict).map((file) => conflictItem(app, file.path)),
			),
		},
	];
}

/** Settings search also builds definitions, so loading starts only when the placeholder row renders. */
function remoteItems<T>(
	controller: PluginController,
	remote: RemoteValue<T>,
	update: () => void,
	items: (value: T) => SettingGroupItem[],
): SettingGroupItem[] {
	if (remote.value !== undefined) {
		return items(remote.value);
	}

	return [
		{
			name: t(($) => $.ui.loading),
			searchable: false,
			render: () => remote.request(controller, update),
		},
	];
}

function deviceItem(
	device: Device,
	controller: PluginController,
	refresh: () => void,
): SettingGroupItem {
	return {
		name: device.name,
		desc: device.id,
		render: (setting) => {
			setting.addButton((button) =>
				button.setButtonText(t(($) => $.ui.deleteDevice)).onClick(() => {
					void controller.run(async () => {
						await controller.deleteDevice(device.id);
						refresh();
					});
				}),
			);
		},
	};
}

function conflictItem(app: App, path: string): SettingGroupItem {
	return {
		name: path,
		render: (setting) => {
			setting.addButton((button) =>
				button.setButtonText(t(($) => $.ui.open)).onClick(() => {
					void app.workspace.openLinkText(path, "");
				}),
			);
		},
	};
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

function renderCreateVault(setting: Setting, controller: PluginController, refresh: () => void) {
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

					await controller.account().createVault(name);
					refresh();
				});
			}),
		);
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
