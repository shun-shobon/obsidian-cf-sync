import type { Device, VaultInfo } from "@cf-sync/protocol";
import { DurableObject } from "cloudflare:workers";

import { ApplicationError } from "../../domain/errors";
import { AccountRepository } from "../account-repository";
import type { Env } from "../env";
import { rpcResult, unwrapRpcResult } from "../rpc-result";
import type { RpcResult } from "../rpc-result";

export class Account extends DurableObject<Env> {
	private readonly repository: AccountRepository;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);

		this.repository = new AccountRepository(state.storage);
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
		return rpcResult(() => this.activeDevice(id));
	}

	authorizeVaultAccess(deviceId: string, vaultId: string): Promise<RpcResult<void>> {
		return rpcResult(async () => {
			await this.activeDevice(deviceId);
			await this.repository.vault(vaultId);
		});
	}

	revokeDevice(id: string): Promise<RpcResult<void>> {
		return rpcResult(async () => {
			const device = await this.repository.device(id);
			await this.repository.revoke(device);

			const vaults = await this.repository.vaults();
			await Promise.all(vaults.map((vault) => this.closeDeviceConnections(vault.id, id)));
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

	private async activeDevice(id: string): Promise<Device> {
		const device = await this.repository.device(id);

		if (device.revoked) {
			throw new ApplicationError("forbidden", "Device revoked");
		}

		return device;
	}

	private async closeDeviceConnections(vaultId: string, deviceId: string): Promise<void> {
		const vault = this.env.VAULTS.getByName(vaultId);

		unwrapRpcResult(await vault.revokeDevice(deviceId));
	}
}
