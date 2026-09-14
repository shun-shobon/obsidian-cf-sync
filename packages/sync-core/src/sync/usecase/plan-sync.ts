import type { SyncPlan } from "../domain/sync-plan";
import { PlanningStore } from "../infra/planning-store";
import { PlanningVault } from "../infra/planning-vault";
import { buildSyncPlan } from "../service/sync-plan";

import type { SyncOnceOptions } from "./sync-once-options";
import { SyncSession } from "./sync-session";

export class PlanSync {
  constructor(private readonly options: SyncOnceOptions) {}

  async run(): Promise<SyncPlan> {
    const vault = new PlanningVault(this.options.vault);
    const store = new PlanningStore(this.options.store);
    const session = new SyncSession({ ...this.options, vault, store });

    try {
      const snapshot = await session.prepare();

      return buildSyncPlan(session.state.data, snapshot, vault.changed);
    } finally {
      session.dispose();
    }
  }
}
