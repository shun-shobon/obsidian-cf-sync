import { t } from "../i18n";

export function serverOrigin(value: string): string {
  if (!URL.canParse(value)) {
    throw new Error(t(($) => $.errors.serverOrigin));
  }

  const url = new URL(value);
  const isHttps = url.protocol === "https:";
  const hasCredentials = Boolean(url.username || url.password);
  const hasExtraComponents = Boolean(url.search || url.hash || url.pathname !== "/");

  if (!isHttps || hasCredentials || hasExtraComponents) {
    throw new Error(t(($) => $.errors.serverOrigin));
  }

  return url.origin;
}
