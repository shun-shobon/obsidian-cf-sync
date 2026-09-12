import type { Device } from "@cf-sync/protocol";

import type { DeviceConnections, DeviceRegistry } from "./ports";

export async function revokeDevice(
  device: Device,
  repository: DeviceRegistry,
  connections: DeviceConnections,
): Promise<void> {
  await repository.revoke(device);
  const registered = await repository.vaults();
  await Promise.all(registered.map((vault) => connections.revoke(vault.id, device.id)));
}
