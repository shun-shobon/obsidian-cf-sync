/* oxlint-disable typescript/no-unnecessary-type-parameters -- 呼び出し側でWorkerの応答の型を指定するための型引数 */

export function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}

export async function readJson<T>(response: { text(): Promise<string> }): Promise<T> {
	return parseJson<T>(await response.text());
}
