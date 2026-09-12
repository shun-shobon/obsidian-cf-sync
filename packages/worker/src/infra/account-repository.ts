import type { Device, VaultInfo } from "@cf-sync/protocol";

import { ApplicationError } from "../domain/errors";

export class AccountRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  registerDevice(input: { id: string; name: string }): Promise<Device> {
    return this.storage.transaction(async (tx) => {
      const previous = await tx.get<Device>(`device:${input.id}`);
      if (previous?.revoked) throw new ApplicationError("forbidden", "Device revoked");
      const device: Device = { ...input, revoked: false };
      await tx.put(`device:${input.id}`, device);
      return device;
    });
  }

  async devices(): Promise<Device[]> {
    return [...(await this.storage.list<Device>({ prefix: "device:" })).values()];
  }

  async device(id: string): Promise<Device> {
    const device = await this.storage.get<Device>(`device:${id}`);
    if (!device) throw new ApplicationError("not-found", "Unknown device");
    return device;
  }

  async revoke(device: Device): Promise<void> {
    await this.storage.put(`device:${device.id}`, { ...device, revoked: true });
  }

  async vaults(): Promise<VaultInfo[]> {
    return [...(await this.storage.list<VaultInfo>({ prefix: "vault:" })).values()];
  }

  async vault(id: string): Promise<VaultInfo> {
    const vault = await this.storage.get<VaultInfo>(`vault:${id}`);
    if (!vault) throw new ApplicationError("not-found", "Unknown vault");
    return vault;
  }

  async saveVault(vault: VaultInfo): Promise<void> {
    await this.storage.put(`vault:${vault.id}`, vault);
  }
}
