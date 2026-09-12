import type { DeviceConnections } from "../usecase/ports";

export class DurableObjectDeviceConnections implements DeviceConnections {
  constructor(private readonly vaults: DurableObjectNamespace) {}

  async revoke(vaultId: string, deviceId: string): Promise<void> {
    const response = await this.vaults
      .get(this.vaults.idFromName(vaultId))
      .fetch("https://internal/revoke", {
        method: "POST",
        body: JSON.stringify({ deviceId }),
      });
    if (!response.ok) throw new Error("Could not revoke vault connections");
  }
}
