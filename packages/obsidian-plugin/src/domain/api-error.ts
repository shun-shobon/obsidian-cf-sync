export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`同期 API エラー (${status})`);
  }
}
