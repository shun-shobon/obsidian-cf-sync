import type { Device, VaultInfo } from "@cf-sync/protocol";
import { DurableObject } from "cloudflare:workers";

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

	renameDevice(device: Device): Promise<RpcResult<Device>> {
		return rpcResult(() => this.repository.renameDevice(device));
	}

	authorizeVaultAccess(deviceId: string, vaultId: string): Promise<RpcResult<void>> {
		return rpcResult(async () => {
			await this.repository.assertDevice(deviceId);
			await this.repository.vault(vaultId);
		});
	}

	deleteDevice(id: string): Promise<RpcResult<void>> {
		return rpcResult(async () => {
			await this.repository.deleteDevice(id);

			const vaults = await this.repository.vaults();
			await Promise.all(
				vaults.map(async (vault) => {
					const result = await this.env.VAULTS.getByName(vault.id).removeDevice(id);
					unwrapRpcResult(result);
				}),
			);
			console.info({ event: "device.deleted", deviceId: id });
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
