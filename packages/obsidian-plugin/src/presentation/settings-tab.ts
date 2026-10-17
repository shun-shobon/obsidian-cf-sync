import { PluginSettingTab } from "obsidian";
import type { Setting, App, Plugin, SettingDefinitionItem } from "obsidian";

import { serverOrigin } from "../domain/server-origin";
import { t } from "../i18n";
import type { PluginController } from "./plugin-controller";
import { remoteSettingDefinitions, remoteValues } from "./settings/remote-settings";
import type { RemoteValues } from "./settings/remote-settings";
import { statusText } from "./status";

export class SyncSettingsTab extends PluginSettingTab {
	private readonly remote: RemoteValues;

	constructor(
		app: App,
		plugin: Plugin,
		private readonly controller: PluginController,
	) {
		super(app, plugin);
		this.remote = remoteValues(controller);
	}

	override hide() {
		this.clearRemoteValues();
		super.hide();
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		let description: string = t(($) => $.ui.disconnected);
		if (this.controller.status) {
			description = statusText(this.controller.status);
		}

		const definitions: SettingDefinitionItem[] = [
			{
				type: "group",
				heading: "CF Sync",
				items: [
					{
						name: t(($) => $.ui.serverUrl),
						desc: t(($) => $.ui.serverUrlDescription),
						render: (setting) => this.renderServerSettings(setting),
					},
					{
						name: t(($) => $.ui.deviceName),
						render: (setting) => this.renderDeviceName(setting),
					},
					{
						name: t(($) => $.ui.authentication),
						desc: t(($) => $.ui.authenticationDescription),
						render: (setting) => this.renderAuthenticationSettings(setting),
					},
					{
						name: t(($) => $.ui.pauseSync),
						render: (setting) => {
							setting.addToggle((input) =>
								input
									.setValue(this.controller.config.paused)
									.onChange((value) => this.controller.run(() => this.controller.setPaused(value))),
							);
						},
					},
					{
						name: t(($) => $.ui.syncStatus),
						desc: description,
						render: (setting) => this.renderSyncSettings(setting),
					},
				],
			},
		];

		if (this.controller.config.server && this.controller.config.auth.tokens) {
			definitions.push(...this.remoteSettingDefinitions());
		}

		return definitions;
	}

	private remoteSettingDefinitions() {
		return remoteSettingDefinitions(
			this.app,
			this.controller,
			this.remote,
			() => this.refresh(),
			() => this.update(),
		);
	}

	private refresh() {
		this.clearRemoteValues();
		this.update();
	}

	private clearRemoteValues() {
		this.remote.devices.clear();
		this.remote.snapshot.clear();
	}

	private renderDeviceName(setting: Setting) {
		setting.addText((input) => {
			input.setValue(this.controller.config.deviceName).onChange((value) => {
				void this.controller.run(() => this.controller.setDeviceName(value));
			});
			// change fires once editing is committed, so the server and device list are not updated per keystroke.
			input.inputEl.addEventListener("change", () => {
				void this.controller.run(async () => {
					await this.controller.saveDeviceName();
					this.refresh();
				});
			});
		});
	}

	private renderServerSettings(setting: Setting) {
		let server = this.controller.config.server;
		setting
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
						this.refresh();
					});
				}),
			);
	}

	private renderAuthenticationSettings(setting: Setting) {
		setting
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

	private renderSyncSettings(setting: Setting) {
		setting.addButton((button) =>
			button.setButtonText(t(($) => $.ui.syncNow)).onClick(() => {
				void this.controller.run(async () => {
					await this.controller.syncNow();
					this.refresh();
				});
			}),
		);
	}
}
