import { isExcluded, type Operation, type OperationResult } from "@cf-sync/protocol";

import type { LocalFile } from "../domain/sync-state";
import type { ApiPort } from "../ports/api-port";
import type { StoredData } from "../ports/sync-store";
import type { Documents } from "../service/documents";
import { rebasePending } from "../service/pending-operations";
import type { SyncState } from "../service/sync-state";

export class SendPending {
  constructor(
    private readonly state: SyncState,
    private readonly api: ApiPort,
    private readonly documents: Documents,
  ) {}

  async run(): Promise<void> {
    for (const operation of this.state.data.pending) {
      const local = this.state.data.files.find((file) => file.id === operation.fileId);
      if (local && isExcluded(local.path, this.state.data.exclusions)) continue;

      await this.uploadContent(operation);
      await this.markAttempted(operation);
      const result = await this.api.operate(operation);
      if (result.opId !== operation.opId) throw new Error("操作応答の ID が一致しません");

      await this.acknowledge(operation, result, local);
      if ("content" in operation && operation.content.kind === "blob") {
        await this.state.store.delete(`blob:${operation.content.blob.key}`);
      }
    }
  }

  private async uploadContent(operation: Operation): Promise<void> {
    if (!("content" in operation) || operation.content.kind !== "blob") return;

    const blob = operation.content.blob;
    const bytes = await this.state.store.get(`blob:${blob.key}`);
    if (!bytes) throw new Error("未送信の添付データがありません");
    await this.api.upload(blob.key, bytes, blob.digest);
  }

  private async markAttempted(operation: Operation): Promise<void> {
    if (this.state.data.attempted.includes(operation.opId)) return;

    this.state.data.attempted.push(operation.opId);
    await this.state.persist();
  }

  private async acknowledge(
    operation: Operation,
    result: OperationResult,
    local: LocalFile | undefined,
  ): Promise<void> {
    const state = this.state.data;
    state.pending = state.pending.filter((entry) => entry.opId !== operation.opId);
    state.attempted = state.attempted.filter((id) => id !== operation.opId);
    if (result.conflict && result.file) {
      this.state.reportConflict(result.file, result.message ?? "競合内容を別名で保護しました");
    }

    const savedData =
      local && result.file ? await this.updateBaseline(local, operation, result) : undefined;
    await this.state.store.save(state, savedData);
  }

  private async updateBaseline(
    local: LocalFile,
    operation: Operation,
    result: OperationResult,
  ): Promise<StoredData | undefined> {
    if (!result.file) return undefined;

    // Keep local content and path until the entire outbox has drained.
    rebasePending(this.state.data.pending, local, operation, result);
    local.revision = result.file.revision;
    local.pathRevision = result.file.pathRevision;
    if (result.file.id === local.id) return undefined;

    const oldId = local.id;
    local.id = result.file.id;
    for (const pending of this.state.data.pending) {
      if (pending.fileId === oldId) pending.fileId = local.id;
    }
    return this.documents.remap(oldId, local);
  }
}
