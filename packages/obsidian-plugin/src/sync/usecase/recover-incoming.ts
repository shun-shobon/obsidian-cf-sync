import { conflictPath, digest, fromBase64 } from "@cf-sync/protocol";
import * as Y from "yjs";

import type { IncomingWrite } from "../domain/sync-state";
import type { VaultPort } from "../ports/vault-port";
import type { Documents } from "../service/documents";
import type { SyncState } from "../service/sync-state";

import type { LocalChanges } from "./local-changes";

export class RecoverIncoming {
  constructor(
    private readonly state: SyncState,
    private readonly vault: VaultPort,
    private readonly documents: Documents,
    private readonly changes: LocalChanges,
  ) {}

  async run(): Promise<void> {
    const incoming = this.state.data.incoming;
    if (!incoming) return;

    const paths = new Set(await this.vault.list());
    const current = paths.has(incoming.file.path)
      ? await this.vault.read(incoming.file.path)
      : undefined;
    const currentDigest = current ? await digest(current) : null;
    if (!current && incoming.expectedDigest !== null) {
      await this.recoverDeletedFile(incoming);
      return;
    }
    if (currentDigest === incoming.expectedDigest) {
      await this.clearIncoming();
      return;
    }
    if (currentDigest !== incoming.digest) {
      await this.recoverChangedFile(incoming, current);
    }
    await this.commitRecovered(incoming);
  }

  private async receivedBytes(): Promise<Uint8Array> {
    const received = await this.state.store.get("incoming");
    if (!received) throw new Error("受信中のファイルデータがありません");
    return received;
  }

  private async clearIncoming(): Promise<void> {
    await this.state.store.save({ ...this.state.data, incoming: null });
    this.state.data.incoming = null;
  }

  private async preserveCopy(
    incoming: IncomingWrite,
    bytes: Uint8Array,
    message: string,
  ): Promise<void> {
    const recoveryPath = conflictPath(incoming.file.path, crypto.randomUUID());
    await this.vault.write(recoveryPath, bytes);
    await this.changes.capture(recoveryPath);
    const recovered = this.state.data.files.find((file) => file.path === recoveryPath)!;
    this.state.reportConflict(
      { ...incoming.file, ...recovered, size: bytes.length, conflict: true },
      message,
    );
  }

  private async recoverDeletedFile(incoming: IncomingWrite): Promise<void> {
    await this.preserveCopy(
      incoming,
      await this.receivedBytes(),
      "削除と競合した受信内容を復旧コピーへ保護しました",
    );
    const deleting = this.state.data.pending.some(
      (operation) => operation.fileId === incoming.file.id && operation.type === "delete",
    );
    if (!deleting) {
      this.state.data.pending.push({
        type: "delete",
        opId: crypto.randomUUID(),
        fileId: incoming.file.id,
        baseRevision: incoming.file.revision,
      });
    }
    await this.clearIncoming();
  }

  private async recoverChangedFile(
    incoming: IncomingWrite,
    current: Uint8Array | undefined,
  ): Promise<void> {
    if (current) {
      await this.preserveCopy(
        incoming,
        current,
        "中断中に変更された内容を復旧コピーへ保護しました",
      );
    }
    const received = await this.receivedBytes();
    if (!(await this.vault.writeIfUnchanged(incoming.file.path, current, received))) {
      throw new Error("受信回復中にファイルが変更されました。再試行します");
    }
  }

  private async commitRecovered(incoming: IncomingWrite): Promise<void> {
    let local = this.state.data.files.find((file) => file.id === incoming.file.id);
    const received = {
      ...incoming.file,
      digest: incoming.digest,
      diskDigest: incoming.digest,
      documentRevision: incoming.file.revision,
    };
    if (!local) {
      local = received;
      this.state.data.files.push(local);
    } else Object.assign(local, received);

    const data = incoming.update
      ? { key: `doc:${local.id}`, value: fromBase64(incoming.update) }
      : undefined;
    await this.state.store.save({ ...this.state.data, incoming: null }, data);
    this.state.data.incoming = null;
    const doc = this.documents.get(local.id);
    if (data && doc) Y.applyUpdate(doc, data.value, "remote");
  }
}
