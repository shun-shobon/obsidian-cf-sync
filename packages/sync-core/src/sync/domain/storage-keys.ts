export const incomingKey = "incoming";

export function documentKey(fileId: string): string {
	return `doc:${fileId}`;
}

export function blobKey(key: string): string {
	return `blob:${key}`;
}
