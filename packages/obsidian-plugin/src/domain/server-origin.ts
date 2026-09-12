export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("サーバーはパスを含まない HTTPS URL を指定してください");
  return url.origin;
}
