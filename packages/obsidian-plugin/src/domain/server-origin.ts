export function serverOrigin(value: string): string {
  const url = new URL(value);
  const isHttps = url.protocol === "https:";
  const hasCredentials = Boolean(url.username || url.password);
  const hasExtraComponents = Boolean(url.search || url.hash || url.pathname !== "/");

  if (!isHttps || hasCredentials || hasExtraComponents) {
    throw new Error("サーバーはパスを含まない HTTPS URL を指定してください");
  }

  return url.origin;
}
