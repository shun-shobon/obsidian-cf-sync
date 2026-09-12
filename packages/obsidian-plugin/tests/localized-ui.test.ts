import type { Plugin } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLanguage } from "../src/i18n";
import { registerCommands } from "../src/presentation/commands";
import type { PluginController } from "../src/presentation/plugin-controller";
import { statusText } from "../src/presentation/status";

const pendingStatus = {
  phase: "r2-pending",
  pending: 3,
  revision: 8,
  r2Revision: 7,
} as const;

afterEach(() => setLanguage("en"));

describe("localized UI", () => {
  it("uses the selected language for persistence status and pending counts", () => {
    setLanguage("ja");
    expect(statusText(pendingStatus)).toBe("DO 保存済み・R2 反映待ち / 未送信 3");
    setLanguage("en");
    expect(statusText(pendingStatus)).toBe("Saved to DO, pending R2 / Pending 3");
  });

  it("preserves error details alongside the localized status", () => {
    setLanguage("ja");
    expect(statusText({ ...pendingStatus, phase: "error", error: "HTTP 503" })).toBe(
      "エラー / 未送信 3 / HTTP 503",
    );
  });

  it("localizes command names while preserving their stable IDs", () => {
    const addCommand = vi.fn();
    const plugin = { addCommand } as unknown as Plugin;
    const controller = {} as PluginController;

    setLanguage("en");
    registerCommands(plugin, controller);
    expect(addCommand.mock.calls.map(([command]) => [command.id, command.name])).toEqual([
      ["sync-now", "Sync now"],
      ["toggle-pause", "Pause or resume sync"],
    ]);

    addCommand.mockClear();
    setLanguage("ja");
    registerCommands(plugin, controller);
    expect(addCommand.mock.calls.map(([command]) => [command.id, command.name])).toEqual([
      ["sync-now", "今すぐ同期"],
      ["toggle-pause", "同期の一時停止・再開"],
    ]);
  });
});
