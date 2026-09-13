import { Window } from "happy-dom";
import type { App, Plugin, Setting, SettingDefinitionItem } from "obsidian";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  PluginSettingTab: class {
    constructor(readonly app: App) {}
  },
  Setting: class {},
}));

import type { PluginController } from "../src/presentation/plugin-controller";
import { SyncSettingsTab } from "../src/presentation/settings-tab";

function createTab() {
  const api = vi.fn();
  const controller = {
    config: { server: "https://sync.example.com", auth: { tokens: {} }, vaultId: "vault" },
    api,
    run: (operation: () => Promise<void>) => operation(),
  } as unknown as PluginController;
  return { tab: new SyncSettingsTab({} as App, {} as Plugin, controller), api };
}

function names(items: SettingDefinitionItem[]): string[] {
  return items.flatMap((item) => {
    if ("name" in item) {
      return [item.name];
    }
    return names(item.items ?? []);
  });
}

describe("declarative settings", () => {
  it("indexes local and remote setting names without making network requests", () => {
    const { tab, api } = createTab();
    expect(names(tab.getSettingDefinitions())).toEqual([
      "Server URL",
      "Device name",
      "Authentication",
      "Pause sync",
      "Sync status",
      "Remote vault",
      "Create a vault on the server",
      "Devices",
      "Excluded paths",
      "Conflict files",
    ]);
    expect(api).not.toHaveBeenCalled();
  });

  it("does not render a remote response after the setting has been torn down", async () => {
    const { tab, api } = createTab();
    let resolve!: (value: []) => void;
    const response = new Promise<[]>((done) => {
      resolve = done;
    });
    api.mockReturnValue({ vaults: () => response });
    const definition = tab
      .getSettingDefinitions()
      .find((item) => "name" in item && item.name === "Remote vault");
    if (!definition || !("render" in definition) || !definition.render) {
      throw new Error("Remote vault render definition is missing");
    }
    const addDropdown = vi.fn();
    const cleanup = definition.render({ addDropdown } as unknown as Setting, {} as never);
    expect(api).toHaveBeenCalledOnce();
    if (typeof cleanup !== "function") {
      throw new Error("Remote vault render cleanup is missing");
    }
    cleanup();
    resolve([]);
    await response;
    expect(addDropdown).not.toHaveBeenCalled();
  });

  it("removes the extra device container when the rendered row is torn down", async () => {
    const { tab, api } = createTab();
    api.mockReturnValue({ devices: async () => [] });
    const document = new Window().document;
    const container = document.createElement("div");
    const settingEl = document.createElement("div");
    container.append(settingEl);
    const definition = tab
      .getSettingDefinitions()
      .find((item) => "name" in item && item.name === "Devices");
    if (!definition || !("render" in definition) || !definition.render) {
      throw new Error("Devices render definition is missing");
    }
    const cleanup = definition.render(
      { settingEl, setHeading: vi.fn() } as unknown as Setting,
      {} as never,
    );
    await Promise.resolve();
    expect(container.children.length).toBe(2);
    if (typeof cleanup !== "function") {
      throw new Error("Devices render cleanup is missing");
    }
    cleanup();
    expect(Array.from(container.children)).toEqual([settingEl]);
  });
});
