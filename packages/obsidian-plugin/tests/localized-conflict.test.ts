import "fake-indexeddb/auto";
import type { OperationResult } from "@cf-sync/protocol";
import type { ApiPort } from "@cf-sync/sync-core/sync/ports/api-port";
import type { Documents } from "@cf-sync/sync-core/sync/service/documents";
import { SyncState } from "@cf-sync/sync-core/sync/service/sync-state";
import { SendPending } from "@cf-sync/sync-core/sync/usecase/send-pending";
import { afterEach, expect, it, vi } from "vitest";

import { setLanguage } from "../src/i18n";
import { IndexedDbStore } from "../src/sync/infra/storage/indexed-db-store";

const cases: [OperationResult["conflictReason"], string, string][] = [
  [
    "move-rejected",
    "Move rejected: path changed or destination occupied",
    "パスが変更されたか移動先が使用中のため、移動できませんでした",
  ],
  [
    "edit-preserved",
    "Concurrent edit preserved before deletion",
    "同時に編集された内容を削除前に保護しました",
  ],
  [
    "content-preserved",
    "Concurrent contents preserved as conflict copy",
    "同時に変更された内容を競合コピーとして保護しました",
  ],
  [
    undefined,
    "Conflicting content was preserved under a different name.",
    "競合内容を別名で保護しました",
  ],
];

afterEach(() => setLanguage("en"));

it.each(cases)(
  "localizes acknowledged conflicts: %s",
  async (conflictReason, english, japanese) => {
    for (const [language, expected] of [
      ["en", english],
      ["ja", japanese],
    ] as const) {
      setLanguage(language);
      const store = new IndexedDbStore(crypto.randomUUID());
      try {
        const onConflict = vi.fn();
        const state = new SyncState(store, () => {}, onConflict);
        const operation = {
          type: "delete" as const,
          opId: crypto.randomUUID(),
          fileId: crypto.randomUUID(),
          baseRevision: 1,
        };
        state.data.pending.push(operation);
        state.data.files.push({
          id: operation.fileId,
          path: "note.md",
          kind: "text",
          digest: "",
          diskDigest: "",
          documentRevision: 1,
          revision: 1,
          pathRevision: 1,
        });
        const result: OperationResult = {
          opId: operation.opId,
          revision: 2,
          previousRevision: 1,
          previousPathRevision: 1,
          conflict: true,
          file: {
            id: crypto.randomUUID(),
            path: "note.conflict.md",
            kind: "text",
            revision: 2,
            pathRevision: 2,
            digest: "",
            size: 0,
            conflict: true,
          },
        };
        if (conflictReason !== undefined) {
          result.conflictReason = conflictReason;
        }
        const api = { operate: vi.fn().mockResolvedValue(result) } as unknown as ApiPort;
        await new SendPending(
          state,
          api,
          {} as Documents,
          (work) => work(),
          (operation) => api.operate(operation),
          () => {},
        ).run(() => true);
        expect(onConflict).toHaveBeenCalledWith(result.file, expected);
        expect((await store.load())?.pending).toEqual([]);
        expect(state.data.files[0]?.id).toBe(operation.fileId);
        expect(state.data.files[0]?.path).toBe("note.md");
      } finally {
        store.close();
      }
    }
  },
);
