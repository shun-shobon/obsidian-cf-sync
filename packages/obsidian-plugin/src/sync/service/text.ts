import { simpleDiffString } from "lib0/diff";
import * as Y from "yjs";

/** Preserve the unchanged prefix/suffix so external edits retain CRDT identity. */
export function replaceText(doc: Y.Doc, value: string, origin: unknown): void {
  const text = doc.getText("content");
  const previous = text.toString();
  if (previous === value) {
    return;
  }

  const change = simpleDiffString(previous, value);

  doc.transact(() => {
    text.delete(change.index, change.remove);
    text.insert(change.index, change.insert);
  }, origin);
}
