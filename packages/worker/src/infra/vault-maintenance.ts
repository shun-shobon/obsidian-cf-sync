import { FLUSH_INTERVAL_MS } from "../domain/vault-state";
import type { VaultSockets } from "./vault-sockets";

export type MaintenanceTask = "flush" | "blobs";

export type AlarmStorage = DurableObjectStorage | DurableObjectTransaction;

export class VaultMaintenance {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly sockets: VaultSockets,
	) {}

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

		if (next == null) {
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
		const deadlines = [...tasks.values(), ...(await this.sockets.ticketExpiries(storage))];

		if (deadlines.length === 0) {
			await storage.deleteAlarm();
			return;
		}

		await storage.setAlarm(Math.min(...deadlines));
	}
}
