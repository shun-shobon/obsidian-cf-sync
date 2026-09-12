import type { App } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({
  desktop: false,
  elements: [] as {
    tag: string;
    options: { text?: string; href?: string };
    addEventListener: ReturnType<typeof vi.fn>;
  }[],
  close: () => {},
}));

vi.mock("obsidian", () => ({
  Platform: {
    get isDesktopApp() {
      return ui.desktop;
    },
  },
  Modal: class {
    titleEl = { setText: vi.fn() };
    contentEl = {
      empty: () => {
        ui.elements = [];
      },
      createEl: (tag: string, options: { text?: string; href?: string }) => {
        const element = { tag, options, addEventListener: vi.fn() };
        ui.elements.push(element);
        return element;
      },
    };
    onOpen() {}
    onClose() {}
    open() {
      ui.close = () => this.close();
      this.onOpen();
    }
    close() {
      this.onClose();
    }
  },
}));

import { loginInBrowser } from "../src/presentation/login-modal";

const app = {} as App;
const url = "https://auth.example.com/authorize?state=test&code_challenge=challenge";

beforeEach(() => {
  vi.useFakeTimers();
  ui.desktop = false;
  ui.elements = [];
  vi.stubGlobal("window", { open: vi.fn() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser login", () => {
  it("shows progress immediately, then a native mobile link without opening a popup", async () => {
    let resolve!: (url: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const preparation = loginInBrowser(app, () => pending);
    expect(ui.elements.map((element) => element.options.text)).toEqual(["Preparing login…"]);

    resolve(url);
    await preparation;

    const link = ui.elements.find((element) => element.tag === "a");
    expect(link?.options).toEqual({ href: url, text: "Log in with browser" });
    const event = { preventDefault: vi.fn() };
    link?.addEventListener.mock.calls[0]?.[1](event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(ui.elements).toContain(link);
    expect(window.open).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(ui.elements).toEqual([]);
  });

  it("opens the desktop default browser synchronously only when the link is clicked", async () => {
    ui.desktop = true;
    await loginInBrowser(app, () => Promise.resolve(url));
    expect(window.open).not.toHaveBeenCalled();

    const link = ui.elements.find((element) => element.tag === "a");
    const listener = link?.addEventListener.mock.calls[0];
    expect(listener?.[0]).toBe("click");
    const event = { preventDefault: vi.fn() };
    listener?.[1](event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.open).toHaveBeenCalledExactlyOnceWith(url, "_external");
    vi.runAllTimers();
    expect(ui.elements).toEqual([]);
  });

  it("does not render a login link after the modal is closed during preparation", async () => {
    let resolve!: (url: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const preparation = loginInBrowser(app, () => pending);
    ui.close();
    resolve(url);
    await preparation;
    expect(ui.elements).toEqual([]);
    expect(window.open).not.toHaveBeenCalled();
  });

  it("closes the progress view and propagates preparation errors for the controller to report", async () => {
    const error = new Error("Registration failed");
    await expect(loginInBrowser(app, () => Promise.reject(error))).rejects.toBe(error);
    expect(ui.elements).toEqual([]);
    expect(window.open).not.toHaveBeenCalled();
  });
});
