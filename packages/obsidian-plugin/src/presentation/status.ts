import type { SyncStatus } from "../sync/domain/sync-state";

const labels: Record<SyncStatus["phase"], string> = {
  starting: "準備中",
  syncing: "同期中",
  synced: "R2 反映済み",
  "r2-pending": "DO 保存済み・R2 反映待ち",
  offline: "オフライン",
  paused: "一時停止",
  error: "エラー",
};

export function statusText(status: SyncStatus): string {
  return `${labels[status.phase]} / 未送信 ${status.pending}${status.error ? ` / ${status.error}` : ""}`;
}
