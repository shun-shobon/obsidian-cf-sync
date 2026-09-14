import type { FileRecord, Snapshot } from "@cf-sync/protocol";

import { Documents } from "../service/documents";
import { SyncState } from "../service/sync-state";

import { LocalChanges } from "./local-changes";
import { ReceiveFile } from "./receive-file";
import { ReconcileVault } from "./reconcile-vault";
import { RecoverIncoming } from "./recover-incoming";
import type { SyncOnceOptions } from "./sync-once-options";

export class SyncSession {
  readonly conflicts: FileRecord[] = [];
  readonly state: SyncState;
  readonly documents: Documents;
  private readonly changes: LocalChanges;
  readonly receive: ReceiveFile;
  readonly reconcile: ReconcileVault;
  private readonly recovery: RecoverIncoming;

  constructor(private readonly options: SyncOnceOptions) {
    const { vault, store, api } = options;

    this.state = new SyncState(
      store,
      () => {},
      (file) => this.conflicts.push(file),
    );
    this.documents = new Documents(
      store,
      () => {},
      () => {},
    );
    this.changes = new LocalChanges(this.state, vault, this.documents, () => {});
    this.receive = new ReceiveFile(this.state, vault, api, this.documents, this.changes);
    this.reconcile = new ReconcileVault(
      this.state,
      vault,
      this.documents,
      this.changes,
      this.receive,
      async () => true,
    );
    this.recovery = new RecoverIncoming(this.state, vault, this.documents, this.changes);
  }

  async prepare(): Promise<Snapshot> {
    await this.state.load();

    const snapshot = await this.options.api.snapshot();
    this.state.data.exclusions = snapshot.exclusions;

    await this.recovery.run();
    await this.changes.scan();
    await this.reconcile.initialize(snapshot);

    return snapshot;
  }

  dispose(): void {
    this.documents.dispose();
  }
}
