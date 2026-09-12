import type { DeviceConnections } from "../usecase/ports";

import type { Vault } from "./durable-objects/vault";
import { unwrapRpcResult } from "./rpc-result";

export class DurableObjectDeviceConnections implements DeviceConnections {
  constructor(private readonly vaults: DurableObjectNamespace<Vault>) {}

  async revoke(vaultId: string, deviceId: string): Promise<void> {
    const vault = this.vaults.getByName(vaultId);
    const result = await vault.revokeDevice(deviceId);

    unwrapRpcResult(result);
  }
}
