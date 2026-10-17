import type { FileRecord } from "@cf-sync/protocol";

import type { SyncStatus } from "../domain/sync-state";
import type { ApiPort } from "../ports/api-port";
import type { SyncOnceOptions } from "./sync-once-options";

export interface SyncOptions extends SyncOnceOptions {
	api: ApiPort;
	deviceId: string;
	deviceName: string;
	onStatus: (status: SyncStatus) => void;
	onConflict: (file: FileRecord, message: string) => void;
	confirmInitial: (paths: string[]) => Promise<boolean>;
}
