import type { Device, VaultInfo } from "@cf-sync/protocol";

import { ApplicationError } from "../domain/errors";

// Records written before device deletion replaced revocation may still carry revoked: true.
type StoredDevice = Device & { revoked?: boolean };

export class AccountRepository {
	constructor(private readonly storage: DurableObjectStorage) {}

	async registerDevice(device: Device): Promise<Device> {
		await this.storage.put(`device:${device.id}`, device);

		return device;
	}

	async devices(): Promise<Device[]> {
		const devices = await this.storage.list<StoredDevice>({ prefix: "device:" });

		return [...devices.values()].filter(isActive).map(({ id, name }) => ({ id, name }));
	}

	async assertDevice(id: string): Promise<void> {
		const device = await this.storage.get<StoredDevice>(`device:${id}`);

		if (!device || !isActive(device)) {
			throw new ApplicationError("forbidden", "Unknown device");
		}
	}

	async deleteDevice(id: string): Promise<void> {
		await this.storage.delete(`device:${id}`);
	}

	async vaults(): Promise<VaultInfo[]> {
		const vaults = await this.storage.list<VaultInfo>({ prefix: "vault:" });

		return [...vaults.values()];
	}

	async vault(id: string): Promise<VaultInfo> {
		const vault = await this.storage.get<VaultInfo>(`vault:${id}`);

		if (!vault) {
			throw new ApplicationError("not-found", "Unknown vault");
		}

		return vault;
	}

	async saveVault(vault: VaultInfo): Promise<void> {
		await this.storage.put(`vault:${vault.id}`, vault);
	}
}

function isActive(device: StoredDevice): boolean {
	return device.revoked !== true;
}
