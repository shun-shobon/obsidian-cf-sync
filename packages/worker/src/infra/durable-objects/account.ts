import type { Device, VaultInfo } from "@cf-sync/protocol";
import { DurableObject } from "cloudflare:workers";

import { ApplicationError } from "../../domain/errors";
import { revokeDevice } from "../../usecase/revoke-device";
import { AccountRepository } from "../account-repository";
import { DurableObjectDeviceConnections } from "../device-connections";
import type { Env } from "../env";
import { rpcResult, type RpcResult } from "../rpc-result";

export class Account extends DurableObject<Env> {
  private readonly repository: AccountRepository;
  private readonly connections: DurableObjectDeviceConnections;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    this.repository = new AccountRepository(state.storage);
    this.connections = new DurableObjectDeviceConnections(env.VAULTS);
  }

  devices(): Promise<RpcResult<Device[]>> {
    return rpcResult(() => this.repository.devices());
  }

  registerDevice(input: { id: string; name: string }): Promise<RpcResult<Device>> {
    return rpcResult(async () => {
      const device = await this.repository.registerDevice(input);
      console.info({ event: "device.registered", deviceId: device.id });

      return device;
    });
  }

  device(id: string): Promise<RpcResult<Device>> {
    return rpcResult(async () => {
      const device = await this.repository.device(id);

      if (device.revoked) {
        throw new ApplicationError("forbidden", "Device revoked");
      }

      return device;
    });
  }

  revokeDevice(id: string): Promise<RpcResult<void>> {
    return rpcResult(async () => {
      const device = await this.repository.device(id);
      await revokeDevice(device, this.repository, this.connections);
      console.info({ event: "device.revoked", deviceId: id });
    });
  }

  vaults(): Promise<RpcResult<VaultInfo[]>> {
    return rpcResult(() => this.repository.vaults());
  }

  createVault(input: VaultInfo): Promise<RpcResult<VaultInfo>> {
    return rpcResult(async () => {
      await this.repository.saveVault(input);
      console.info({ event: "vault.created", vaultId: input.id });

      return input;
    });
  }

  vault(id: string): Promise<RpcResult<VaultInfo>> {
    return rpcResult(() => this.repository.vault(id));
  }
}
