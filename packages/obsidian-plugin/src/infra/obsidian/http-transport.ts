import { requestUrl } from "obsidian";

import type { Transport } from "../http/transport";

export const obsidianTransport: Transport = async (request) => {
  const response = await requestUrl({ ...request, throw: false });

  return { status: response.status, text: response.text, bytes: response.arrayBuffer };
};
