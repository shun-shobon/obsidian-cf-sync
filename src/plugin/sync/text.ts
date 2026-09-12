import * as Y from "yjs";
/** Preserve the unchanged prefix/suffix so external edits retain CRDT identity. */
export function replaceText(doc: Y.Doc, value: string, origin: unknown): void {
  const text = doc.getText("content");
  const previous = text.toString();
  if (previous === value) return;
  let start = 0;
  while (start < previous.length && start < value.length && previous[start] === value[start])
    start++;
  let end = 0;
  while (
    end < previous.length - start &&
    end < value.length - start &&
    previous[previous.length - end - 1] === value[value.length - end - 1]
  )
    end++;
  doc.transact(() => {
    text.delete(start, previous.length - start - end);
    text.insert(start, value.slice(start, value.length - end));
  }, origin);
}
