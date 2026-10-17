import type { App, Plugin, Setting, SettingDefinitionItem } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { PluginController } from "../src/presentation/plugin-controller";
import { SyncSettingsTab } from "../src/presentation/settings-tab";

vi.mock("obsidian", () => ({
	PluginSettingTab: class {
		constructor(readonly app: App) {}
		update() {}
		hide() {}
	},
}));

function createTab() {
	const api = vi.fn();
	const account = vi.fn();
	const deleteDevice = vi.fn(async () => {});
	const saveDeviceName = vi.fn(async () => {});
	const controller = {
		config: { server: "https://sync.example.com", auth: { tokens: {} }, vaultId: "vault" },
		api,
		account,
		deleteDevice,
		saveDeviceName,
		setDeviceName: vi.fn(async () => {}),
		run: (operation: () => Promise<void>) => operation(),
	} as unknown as PluginController;
	const tab = new SyncSettingsTab({} as App, {} as Plugin, controller);
	const update = vi.spyOn(tab, "update");
	return { tab, api, account, deleteDevice, saveDeviceName, update };
}

function names(items: SettingDefinitionItem[]): string[] {
	return items.flatMap((item) => {
		if ("name" in item) {
			return [item.name];
		}
		return [item.heading ?? "", ...names(item.items ?? [])];
	});
}

function list(tab: SyncSettingsTab, heading: string) {
	const item = tab
		.getSettingDefinitions()
		.find((candidate) => "heading" in candidate && candidate.heading === heading);
	if (!item || !("items" in item)) {
		throw new Error(`${heading} list is missing`);
	}
	return item.items ?? [];
}

function render(item: SettingDefinitionItem | undefined, setting: Partial<Setting> = {}) {
	if (!item || !("render" in item) || !item.render) {
		throw new Error("Render definition is missing");
	}
	return item.render(setting as Setting, {} as never);
}

describe("declarative settings", () => {
	it("indexes local and remote setting names without making network requests", () => {
		const { tab, api, account } = createTab();
		expect(names(tab.getSettingDefinitions())).toEqual([
			"CF Sync",
			"Server URL",
			"Device name",
			"Authentication",
			"Pause sync",
			"Sync status",
			"Remote vault",
			"Create a vault on the server",
			"Devices",
			"Loading",
			"Excluded paths",
			"Conflict files",
			"Loading",
		]);
		expect(api).not.toHaveBeenCalled();
		expect(account).not.toHaveBeenCalled();
	});

	it("does not render a remote response after the setting has been torn down", async () => {
		const { tab, account } = createTab();
		let resolve!: (value: []) => void;
		const response = new Promise<[]>((done) => {
			resolve = done;
		});
		account.mockReturnValue({ vaults: () => response });
		const definition = tab
			.getSettingDefinitions()
			.find((item) => "name" in item && item.name === "Remote vault");
		if (!definition || !("render" in definition) || !definition.render) {
			throw new Error("Remote vault render definition is missing");
		}
		const addDropdown = vi.fn();
		const cleanup = definition.render({ addDropdown } as unknown as Setting, {} as never);
		expect(account).toHaveBeenCalledOnce();
		if (typeof cleanup !== "function") {
			throw new TypeError("Remote vault render cleanup is missing");
		}
		cleanup();
		resolve([]);
		await response;
		expect(addDropdown).not.toHaveBeenCalled();
	});

	it("loads devices when the list renders and lists each device with a delete button", async () => {
		const { tab, account, deleteDevice, update } = createTab();
		const devices = vi.fn(async () => [{ id: "device-a", name: "Laptop" }]);
		account.mockReturnValue({ devices });
		const [placeholder] = list(tab, "Devices");
		expect(placeholder).toMatchObject({ name: "Loading", searchable: false });
		render(placeholder);
		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());

		const [device] = list(tab, "Devices");
		expect(device).toMatchObject({ name: "Laptop", desc: "device-a" });
		let click!: () => void;
		const button = {
			setButtonText: () => button,
			onClick: (callback: () => void) => {
				click = callback;
				return button;
			},
		};
		render(device, {
			addButton: (configure: (component: typeof button) => void) => configure(button),
		} as never);
		click();
		await vi.waitFor(() => expect(deleteDevice).toHaveBeenCalledWith("device-a"));
		await vi.waitFor(() => expect(list(tab, "Devices")[0]).toMatchObject({ name: "Loading" }));
		expect(devices).toHaveBeenCalledOnce();
	});

	it("keeps loaded devices but does not re-render after the placeholder is torn down", async () => {
		const { tab, account, update } = createTab();
		let resolve!: (value: { id: string; name: string }[]) => void;
		account.mockReturnValue({
			devices: () =>
				new Promise((done) => {
					resolve = done;
				}),
		});
		const cleanup = render(list(tab, "Devices")[0]);
		if (typeof cleanup !== "function") {
			throw new TypeError("Devices placeholder cleanup is missing");
		}
		cleanup();
		resolve([{ id: "device-a", name: "Laptop" }]);
		await vi.waitFor(() => expect(list(tab, "Devices")[0]).toMatchObject({ name: "Laptop" }));
		expect(update).not.toHaveBeenCalled();
	});

	it("saves the device name once editing is committed and reloads the device list", async () => {
		const { tab, saveDeviceName, update } = createTab();
		const inputEl = new EventTarget();
		const input = { inputEl, setValue: () => input, onChange: () => input };
		const definition = tab
			.getSettingDefinitions()
			.flatMap((item) => ("items" in item ? (item.items ?? []) : [item]))
			.find((item) => "name" in item && item.name === "Device name");
		render(definition, {
			addText: (configure: (component: typeof input) => void) => configure(input),
		} as never);
		expect(saveDeviceName).not.toHaveBeenCalled();

		inputEl.dispatchEvent(new Event("change"));

		await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
		expect(saveDeviceName).toHaveBeenCalledOnce();
	});
});
