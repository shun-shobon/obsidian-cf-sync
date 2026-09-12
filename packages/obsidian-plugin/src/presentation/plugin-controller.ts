import { pathSchema } from "@cf-sync/protocol";
import { Notice, type App } from "obsidian";
import * as v from "valibot";

import type { Settings } from "../domain/plugin-settings";
import { t } from "../i18n";
import { OAuthClient } from "../infra/auth/oauth-client";
import { ApiClient } from "../infra/http/api-client";
import { obsidianTransport } from "../infra/obsidian/http-transport";
import { ObsidianVault } from "../infra/obsidian/vault-adapter";
import type { SyncStatus } from "../sync/domain/sync-state";
import { IndexedDbStore } from "../sync/infra/storage/indexed-db-store";
import { SyncEngine } from "../sync/usecase/sync-engine";

import { confirmInitial } from "./confirm-initial";
import { statusText } from "./status";

export class PluginController {
  engine?: SyncEngine;
  status?: SyncStatus;
  readonly vault: ObsidianVault;
  private auth?: OAuthClient;
  private saveQueue = Promise.resolve();
  private setupQueue = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly app: App,
    readonly config: Settings,
    private readonly save: (settings: Settings) => Promise<void>,
    private readonly displayStatus: (message: string) => void,
  ) {
    this.vault = new ObsidianVault(app.vault);
  }

  persist(): Promise<void> {
    const data = structuredClone(this.config);
    this.saveQueue = this.saveQueue.then(
      () => this.save(data),
      () => this.save(data),
    );

    return this.saveQueue;
  }

  authentication(): OAuthClient {
    if (!this.auth) {
      this.auth = new OAuthClient(this.config.server, this.config.auth, obsidianTransport, () =>
        this.persist(),
      );
    }

    return this.auth;
  }

  api(): ApiClient {
    return new ApiClient(
      this.authentication(),
      obsidianTransport,
      this.config.deviceId,
      this.config.vaultId,
    );
  }

  async login() {
    const url = await this.authentication().begin();
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async finishLogin(params: Record<string, string>) {
    await this.authentication().finish(params);
    await this.api().registerDevice(this.config.deviceName);
    new Notice(t(($) => $.ui.loginSuccess));
    await this.connect();
  }

  async logout() {
    this.engine?.pause();
    await this.authentication().logout();
    this.displayStatus(t(($) => $.ui.loginRequired));
  }

  async changeServer(value: string) {
    if (this.config.server === value) {
      return;
    }

    if (this.config.vaultId) {
      throw new Error(t(($) => $.ui.serverAlreadySelected));
    }

    await this.auth?.logout();
    this.auth = undefined;
    this.config.auth = {};
    this.config.server = value;
    await this.persist();
  }

  async selectVault(id: string) {
    if (!id) {
      return;
    }

    this.config.vaultId = id;
    await this.persist();
    await this.connect();
  }

  async setDeviceName(name: string) {
    this.config.deviceName = name;
    await this.persist();
  }

  async revokeDevice(id: string) {
    await this.api().revokeDevice(id);

    if (id === this.config.deviceId) {
      await this.logout();
    }
  }

  async saveExclusions(paths: string[]) {
    const exclusions = v.parse(v.array(pathSchema), paths);
    await this.api().exclusions(exclusions);
    await this.engine?.syncNow();
  }

  async setPaused(paused: boolean) {
    this.config.paused = paused;
    await this.persist();

    if (paused) {
      this.engine?.pause();
    } else if (this.engine) {
      await this.engine.resume();
    } else {
      await this.connect();
    }
  }

  connect(): Promise<void> {
    const setup = () => this.startEngine();
    this.setupQueue = this.setupQueue.then(setup, setup);

    return this.setupQueue;
  }

  private async startEngine() {
    if (this.stopped) {
      return;
    }

    const hasConnection = Boolean(this.config.server && this.config.vaultId);

    if (!hasConnection) {
      return;
    }

    await this.engine?.dispose();
    this.engine = this.createEngine();

    if (this.config.paused) {
      this.engine.pause();
    }

    await this.engine.start();
    this.app.workspace.updateOptions();
  }

  private createEngine(): SyncEngine {
    return new SyncEngine({
      vault: this.vault,
      api: this.api(),
      store: new IndexedDbStore(
        `cf-sync:${this.config.localId}:${this.config.server}:${this.config.vaultId}`,
      ),
      onStatus: (status) => {
        this.status = status;
        this.displayStatus(statusText(status));
      },
      onConflict: (file, message) => {
        new Notice(`${message}\n${file.path}`, 10000);
      },
      confirmInitial: (paths) => confirmInitial(this.app, paths),
    });
  }

  async syncNow() {
    if (!this.engine) {
      await this.connect();
    }

    await this.engine?.refresh();
  }

  async run(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      this.report(error);
    }
  }

  report(error: unknown) {
    let message = String(error);

    if (error instanceof Error) {
      message = error.message;
    }

    new Notice(`CF Sync: ${message}`, 10000);
    this.displayStatus(message);
  }

  dispose() {
    this.stopped = true;
    void this.engine?.dispose();
  }
}
