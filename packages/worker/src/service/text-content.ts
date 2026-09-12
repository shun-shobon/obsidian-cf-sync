import { digest, fromBase64 } from "@cf-sync/protocol";
import * as Y from "yjs";

import { ApplicationError } from "../domain/errors";

export function materializeText(update: string): Uint8Array {
  const doc = new Y.Doc();

  try {
    Y.applyUpdate(doc, fromBase64(update));
    return new TextEncoder().encode(doc.getText("content").toJSON());
  } finally {
    doc.destroy();
  }
}

export async function mergeText(
  update: string,
  previous?: string,
): Promise<{
  update: Uint8Array;
  size: number;
  digest: string;
}> {
  const doc = new Y.Doc();

  try {
    if (previous) Y.applyUpdate(doc, fromBase64(previous));
    Y.applyUpdate(doc, fromBase64(update));
    const plain = new TextEncoder().encode(doc.getText("content").toJSON());

    return { update: Y.encodeStateAsUpdate(doc), size: plain.length, digest: await digest(plain) };
  } catch {
    throw new ApplicationError("invalid-input", "Invalid Yjs update");
  } finally {
    doc.destroy();
  }
}
