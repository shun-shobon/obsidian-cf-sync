export function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export async function ifExists<T>(promise: Promise<T>): Promise<T | undefined> {
	return await promise.catch((error: unknown) => {
		if (hasErrorCode(error, "ENOENT")) {
			return undefined;
		}

		throw error;
	});
}
