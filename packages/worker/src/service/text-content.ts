import { digest } from "@cf-sync/protocol";
import { toUint8Array } from "js-base64";
import * as Y from "yjs";

import { ApplicationError } from "../domain/errors";

export function materializeText(update: string): Uint8Array {
  const doc = new Y.Doc();

  try {
    Y.applyUpdate(doc, toUint8Array(update));

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
    if (previous) {
      Y.applyUpdate(doc, toUint8Array(previous));
    }

    Y.applyUpdate(doc, toUint8Array(update));
    const plain = new TextEncoder().encode(doc.getText("content").toJSON());

    return { update: Y.encodeStateAsUpdate(doc), size: plain.length, digest: await digest(plain) };
  } catch {
    throw new ApplicationError("invalid-input", "Invalid Yjs update");
  } finally {
    doc.destroy();
  }
}
