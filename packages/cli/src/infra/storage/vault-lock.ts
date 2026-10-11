import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function lockVault(directory: string): () => void {
	const db = new DatabaseSync(join(directory, "lock.sqlite"));

	try {
		db.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		db.close();
		throw new Error("Another process is using this Vault", { cause: error });
	}

	return () => {
		db.exec("ROLLBACK");
		db.close();
	};
}
