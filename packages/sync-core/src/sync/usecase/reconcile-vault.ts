import {
  digest,
  isExcluded,
  type DocumentResponse,
  type FileRecord,
  type Snapshot,
} from "@cf-sync/protocol";

import type { LocalFile } from "../domain/sync-state";
import type { VaultPort } from "../ports/vault-port";
import type { Documents } from "../service/documents";
import type { SyncState } from "../service/sync-state";

import type { LocalChanges } from "./local-changes";
import type { ReceiveFile } from "./receive-file";

export class ReconcileVault {
  constructor(
    private readonly state: SyncState,
    private readonly vault: VaultPort,
    private readonly documents: Documents,
    private readonly changes: LocalChanges,
    private readonly receive: ReceiveFile,
    private readonly confirmInitial: (paths: string[]) => Promise<boolean>,
  ) {}

  async initialize(snapshot: Snapshot): Promise<boolean> {
    this.state.data.exclusions = snapshot.exclusions;
    if (this.state.data.initialized) {
      return true;
    }

    const remoteByPath = new Map(snapshot.files.map((file) => [file.path, file]));
    const collisions = this.state.data.files.filter((local) => {
      const remote = remoteByPath.get(local.path);

      return remote && remote.digest !== local.digest;
    });
    if (collisions.length > 0) {
      const conflictingPaths = collisions.map((file) => file.path);
      const confirmed = await this.confirmInitial(conflictingPaths);
      if (!confirmed) {
        return false;
      }
    }

    for (const local of this.state.data.files) {
      const remote = remoteByPath.get(local.path);
      if (!remote || remote.digest !== local.digest) {
        continue;
      }

      this.state.data.pending = this.state.data.pending.filter((op) => op.fileId !== local.id);
      this.state.data.files = this.state.data.files.filter((file) => file.id !== local.id);
      this.documents.remove(local.id);
      await this.receive.run(remote);
    }

    this.state.data.initialized = true;
    await this.state.persist();

    return true;
  }

  async run(
    snapshot: Snapshot,
    serialize: <T>(work: () => Promise<T>) => Promise<T>,
    fetchFile: (
      file: FileRecord,
    ) => Promise<{ document: DocumentResponse; bytes: Uint8Array | undefined }>,
    isActive: () => boolean,
  ): Promise<void> {
    for (const remote of snapshot.files) {
      if (!isActive()) {
        return;
      }
      const needed = await serialize(async () => {
        const local = this.state.data.files.find((file) => file.id === remote.id);
        return (
          !isExcluded(remote.path, snapshot.exclusions) &&
          !this.state.data.pending.some((op) => op.fileId === remote.id) &&
          (!local ||
            local.documentRevision < remote.revision ||
            local.path !== remote.path ||
            local.digest !== remote.digest)
        );
      });
      if (!needed) {
        continue;
      }
      // Fetch attachments outside the state queue so active editors keep working.
      const fetched = await fetchFile(remote);
      await serialize(async () => {
        if (!isActive() || this.state.data.pending.some((op) => op.fileId === remote.id)) {
          return;
        }
        await this.receive.run(fetched.document.file, fetched.document, undefined, fetched.bytes);
      });
    }

    await serialize(async () => {
      if (!isActive()) {
        return;
      }
      const paths = new Set(await this.vault.list());
      const remoteIds = new Set(snapshot.files.map((file) => file.id));
      for (const local of this.state.data.files) {
        const existsRemotely = remoteIds.has(local.id);
        const excluded = isExcluded(local.path, snapshot.exclusions);
        const hasPendingChanges = this.state.data.pending.some((op) => op.fileId === local.id);
        // A socket update or acknowledgment may already be newer than this snapshot.
        if (existsRemotely || excluded || hasPendingChanges || local.revision > snapshot.revision) {
          continue;
        }
        await this.removeDeleted(local, paths);
      }
      this.state.data.revision = Math.max(this.state.data.revision, snapshot.revision);
      this.state.data.r2Revision = Math.max(this.state.data.r2Revision, snapshot.r2Revision);
      await this.state.persist();
    });
  }

  private async removeDeleted(local: LocalFile, paths: Set<string>): Promise<void> {
    if (paths.has(local.path)) {
      const diskBytes = await this.vault.read(local.path);
      const diskDigest = await digest(diskBytes);
      if (diskDigest !== local.digest) {
        await this.changes.capture(local.path);

        return;
      }

      await this.vault.remove(local.path);
    }

    this.state.data.files = this.state.data.files.filter((file) => file.id !== local.id);
    this.documents.remove(local.id);
    await this.state.store.delete(`doc:${local.id}`);
  }
}
