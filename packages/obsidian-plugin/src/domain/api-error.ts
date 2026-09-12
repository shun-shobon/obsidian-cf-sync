import { t } from "../i18n";

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(t(($) => $.errors.apiFailed, { status: status }));
  }
}
