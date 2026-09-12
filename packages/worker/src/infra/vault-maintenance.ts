import { FLUSH_INTERVAL_MS } from "../domain/vault-state";

export type MaintenanceTask = "flush" | "blobs";

type AlarmStorage = DurableObjectStorage | DurableObjectTransaction;

export class VaultMaintenance {
  constructor(private readonly storage: DurableObjectStorage) {}

  async request(task: MaintenanceTask, storage: AlarmStorage = this.storage): Promise<void> {
    const key = `maintenance:${task}`;
    const deadline = Date.now() + FLUSH_INTERVAL_MS;
    const existing = await storage.get<number>(key);

    if (existing === undefined || deadline < existing) {
      await storage.put(key, deadline);
    }

    await this.schedule(storage);
  }

  async due(task: MaintenanceTask): Promise<boolean> {
    const deadline = await this.storage.get<number>(`maintenance:${task}`);

    return deadline !== undefined && deadline <= Date.now();
  }

  async complete(task: MaintenanceTask, next: number | null): Promise<void> {
    const key = `maintenance:${task}`;

    if (next === null) {
      await this.storage.delete(key);
      return;
    }

    await this.storage.put(key, next);
  }

  async retry(): Promise<void> {
    const deadlines = await this.storage.list<number>({ prefix: "maintenance:" });

    for (const [key, deadline] of deadlines) {
      if (deadline <= Date.now()) {
        await this.storage.put(key, Date.now() + FLUSH_INTERVAL_MS);
      }
    }

    await this.schedule();
  }

  async schedule(storage: AlarmStorage = this.storage): Promise<void> {
    const tasks = await storage.list<number>({ prefix: "maintenance:" });
    const tickets = await storage.list<{ expiresAt: number }>({ prefix: "ticket:" });
    const deadlines = [
      ...tasks.values(),
      ...[...tickets.values()].map((ticket) => ticket.expiresAt),
    ];

    if (deadlines.length === 0) {
      await storage.deleteAlarm();
      return;
    }

    let earliest = Infinity;

    for (const deadline of deadlines) {
      earliest = Math.min(earliest, deadline);
    }

    await storage.setAlarm(earliest);
  }
}
