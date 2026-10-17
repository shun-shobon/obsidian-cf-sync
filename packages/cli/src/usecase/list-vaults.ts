import { connectAccount } from "./connect-account";

export async function listVaults(server: string | undefined, env: NodeJS.ProcessEnv) {
	const { account } = await connectAccount(server, env);
	const vaults = await account.vaults();

	return { vaults };
}
