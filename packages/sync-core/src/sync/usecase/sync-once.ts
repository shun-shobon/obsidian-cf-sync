import type { SyncResult } from "../domain/sync-result";
import { needsReceive } from "../service/snapshot-state";

import { SendPending } from "./send-pending";
import type { SyncOnceOptions } from "./sync-once-options";
import { SyncSession } from "./sync-session";

export class SyncOnce {
  private readonly session: SyncSession;
  private readonly sender: SendPending;
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SyncOnceOptions) {
    this.session = new SyncSession(options);
    this.sender = new SendPending(
      this.session.state,
      options.api,
      this.session.documents,
      (work) => this.enqueue(work),
      (operation) => options.api.operate(operation),
      () => {},
    );
  }

  async run(): Promise<SyncResult> {
    try {
      await this.session.prepare();

      let remaining = true;

      while (remaining) {
        remaining = await this.synchronize();
      }

      const { data } = this.session.state;

      return {
        revision: data.revision,
        r2Revision: data.r2Revision,
        pending: data.pending.length,
        conflicts: structuredClone(this.session.conflicts),
      };
    } finally {
      this.session.dispose();
    }
  }

  private async synchronize(): Promise<boolean> {
    const { state, reconcile, receive } = this.session;

    await this.sender.run(() => true);

    const snapshot = await this.options.api.snapshot();
    const filesBefore = JSON.stringify(state.data.files);
    state.data.exclusions = snapshot.exclusions;

    await reconcile.run(
      snapshot,
      (work) => this.enqueue(work),
      (file) => receive.fetch(file.id),
      () => true,
    );

    const pending = state.hasPending();
    const remaining = pending || needsReceive(state.data, snapshot);
    const unchanged = filesBefore === JSON.stringify(state.data.files);

    if (remaining && !pending && unchanged) {
      throw new Error("Could not apply the server snapshot");
    }

    return remaining;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work);
    this.serial = next.catch(() => {});

    return next;
  }
}
