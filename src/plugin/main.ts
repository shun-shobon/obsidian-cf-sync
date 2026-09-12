import { Notice, Plugin, TFile, TFolder, requestUrl } from "obsidian";
import { z } from "zod";

import { ApiClient } from "./api";
import { OAuthClient, authStateSchema, type Transport } from "./auth/oauth";
import { editorExtension } from "./editor/extension";
import { SyncEngine } from "./sync/engine";
import { IndexedDbStore } from "./sync/store";
import type { SyncStatus } from "./sync/types";
import { confirmInitial } from "./ui/confirm";
import { SyncSettingsTab } from "./ui/settings";
import { statusText } from "./ui/status";
import { ObsidianVault } from "./vault";
const settingsSchema = z.object({
  server: z.string(),
  deviceId: z.string().uuid(),
  deviceName: z.string(),
  localId: z.string().uuid(),
  vaultId: z.string(),
  paused: z.boolean(),
  auth: authStateSchema,
});
export type Settings = z.infer<typeof settingsSchema>;
const transport: Transport = async (request) => {
  const response = await requestUrl({ ...request, throw: false });
  return { status: response.status, text: response.text, bytes: response.arrayBuffer };
};
export default class CFSyncPlugin extends Plugin {
  config!: Settings;
  engine?: SyncEngine;
  status?: SyncStatus;
  private auth?: OAuthClient;
  private vaultPort!: ObsidianVault;
  private statusEl!: HTMLElement;
  private saveQueue = Promise.resolve();
  private setupQueue = Promise.resolve();
  private stopped = false;
  override async onload() {
    this.vaultPort = new ObsidianVault(this.app.vault);
    const data: unknown = await this.loadData();
    this.config =
      data === null
        ? {
            server: "",
            deviceId: crypto.randomUUID(),
            deviceName: this.app.vault.getName(),
            localId: crypto.randomUUID(),
            vaultId: "",
            paused: false,
            auth: {},
          }
        : settingsSchema.parse(data);
    await this.persist();
    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText("CF Sync: 未接続");
    this.addSettingTab(new SyncSettingsTab(this.app, this));
    this.registerEditorExtension(
      editorExtension(
        () => this.engine,
        (error) => this.report(error),
      ),
    );
    this.registerObsidianProtocolHandler("cf-sync-auth", (params) => {
      void this.run(async () => {
        await this.authentication().finish(params);
        await this.api().registerDevice(this.config.deviceName);
        new Notice("CF Sync にログインしました");
        await this.connect();
      });
    });
    this.addCommand({
      id: "sync-now",
      name: "今すぐ同期",
      callback: () => {
        void this.run(async () => {
          if (!this.engine) await this.connect();
          await this.engine?.syncNow();
        });
      },
    });
    this.addCommand({
      id: "toggle-pause",
      name: "同期の一時停止・再開",
      callback: () => {
        void this.run(() => this.setPaused(!this.config.paused));
      },
    });
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          const path = file.path;
          void this.run(async () => {
            if (!(await this.vaultPort.isOwnEvent({ type: "create", file, path })))
              await this.engine?.capture(path);
          });
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        const path = file.path;
        void this.run(async () => {
          if (!(await this.vaultPort.isOwnEvent({ type: "modify", file, path })))
            await this.engine?.capture(path);
        });
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const deletedPath = file.path;
        void this.run(async () => {
          if (
            file instanceof TFile &&
            (await this.vaultPort.isOwnEvent({ type: "delete", file, path: deletedPath }))
          )
            return;
          const paths: string[] = [];
          const collect = (entry: typeof file) => {
            if (entry instanceof TFile) paths.push(entry.path);
            else if (entry instanceof TFolder) for (const child of entry.children) collect(child);
          };
          collect(file);
          for (const path of paths) await this.engine?.captureDelete(path);
        });
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const newPath = file.path;
        void this.run(async () => {
          if (file instanceof TFile) {
            if (
              !(await this.vaultPort.isOwnEvent({ type: "rename", file, path: newPath, oldPath }))
            )
              await this.engine?.captureRename(oldPath, newPath);
          } else
            for (const child of this.app.vault
              .getFiles()
              .filter((child) => child.path.startsWith(`${file.path}/`)))
              await this.engine?.captureRename(
                oldPath + child.path.slice(file.path.length),
                child.path,
              );
        });
      }),
    );
    this.registerDomEvent(window, "online", () => {
      void this.run(async () => {
        await this.engine?.syncNow();
      });
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible")
        void this.run(async () => {
          await this.engine?.syncNow();
        });
    });
    this.app.workspace.onLayoutReady(() => {
      void this.run(() => this.connect());
    });
  }
  persist(): Promise<void> {
    const data = structuredClone(this.config);
    this.saveQueue = this.saveQueue.then(
      () => this.saveData(data),
      () => this.saveData(data),
    );
    return this.saveQueue;
  }
  authentication(): OAuthClient {
    if (!this.auth)
      this.auth = new OAuthClient(this.config.server, this.config.auth, transport, () =>
        this.persist(),
      );
    return this.auth;
  }
  api(): ApiClient {
    return new ApiClient(
      this.authentication(),
      transport,
      this.config.deviceId,
      this.config.vaultId,
    );
  }
  async login() {
    const url = await this.authentication().begin();
    window.open(url, "_blank", "noopener,noreferrer");
  }
  async logout() {
    this.engine?.pause();
    await this.authentication().logout();
    this.statusEl.setText("CF Sync: ログインが必要です");
  }
  async changeServer(value: string) {
    if (this.config.server === value) return;
    if (this.config.vaultId)
      throw new Error(
        "接続先 Vault が設定済みです。別サーバーには別のローカル Vault を使用してください",
      );
    await this.auth?.logout();
    this.auth = undefined;
    this.config.auth = {};
    this.config.server = value;
    await this.persist();
  }
  async setPaused(paused: boolean) {
    this.config.paused = paused;
    await this.persist();
    if (paused) this.engine?.pause();
    else if (this.engine) await this.engine.resume();
    else await this.connect();
  }
  connect(): Promise<void> {
    const setup = async () => {
      if (this.stopped || !this.config.server || !this.config.vaultId) return;
      await this.engine?.dispose();
      this.engine = new SyncEngine({
        vault: this.vaultPort,
        api: this.api(),
        store: new IndexedDbStore(
          `cf-sync:${this.config.localId}:${this.config.server}:${this.config.vaultId}`,
        ),
        onStatus: (status) => {
          this.status = status;
          this.statusEl.setText(`CF Sync: ${statusText(status)}`);
        },
        onConflict: (file, message) => {
          new Notice(`${message}\n${file.path}`, 10000);
        },
        confirmInitial: (paths) => confirmInitial(this.app, paths),
      });
      if (this.config.paused) this.engine.pause();
      await this.engine.start();
      this.app.workspace.updateOptions();
    };
    this.setupQueue = this.setupQueue.then(setup, setup);
    return this.setupQueue;
  }
  async run(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      this.report(error);
    }
  }
  report(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    new Notice(`CF Sync: ${message}`, 10000);
    this.statusEl?.setText(`CF Sync: ${message}`);
  }
  override onunload() {
    this.stopped = true;
    void this.engine?.dispose();
  }
}
