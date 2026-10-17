import type { Account } from "./durable-objects/account";
import type { Vault } from "./durable-objects/vault";

export interface Env {
	ACCOUNT: DurableObjectNamespace<Account>;
	VAULTS: DurableObjectNamespace<Vault>;
	BUCKET: R2Bucket;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
}

export function ownerAccount(env: Env): DurableObjectStub<Account> {
	return env.ACCOUNT.getByName("owner");
}
