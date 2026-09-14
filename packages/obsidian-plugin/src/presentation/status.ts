import type { SyncStatus } from "@cf-sync/sync-core/sync/domain/sync-state";

import { t } from "../i18n";

export function statusText(status: SyncStatus): string {
  const labels: Record<SyncStatus["phase"], string> = {
    starting: t(($) => $.ui.starting),
    syncing: t(($) => $.ui.syncing),
    synced: t(($) => $.ui.synced),
    "r2-pending": t(($) => $.ui.r2Pending),
    offline: t(($) => $.ui.offline),
    paused: t(($) => $.ui.paused),
    error: t(($) => $.ui.error),
  };
  const parts = [labels[status.phase], t(($) => $.ui.pending, { count: status.pending })];

  if (status.error) {
    parts.push(status.error);
  }

  return parts.join(" / ");
}
