import type { RestApiPort } from "../ports/api-port";
import type { SyncStore } from "../ports/sync-store";
import type { VaultPort } from "../ports/vault-port";

export interface SyncOnceOptions {
  vault: VaultPort;
  store: SyncStore;
  api: RestApiPort;
}
