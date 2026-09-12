import { expect, it } from "vitest";
import * as Y from "yjs";

import { replaceText } from "../src/sync/service/text";

it.each([
  ["shared high surrogate", "😄", "😁"],
  ["shared low surrogate", "\u{1f604}", "\u{1fa04}"],
])("preserves Unicode when replacing characters with a %s", (_name, before, after) => {
  const doc = new Y.Doc();
  const replica = new Y.Doc();
  const initial = `before ${before} after`;
  const expected = `before ${after} after`;
  doc.getText("content").insert(0, initial);
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));

  replaceText(doc, expected, "external-edit");
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));

  expect(doc.getText("content").toString()).toBe(expected);
  expect(replica.getText("content").toString()).toBe(expected);
  doc.destroy();
  replica.destroy();
});
