import * as v from "valibot";

export const urlSchema = v.pipe(
  v.string(),
  v.trim(),
  v.transform((value) => value.replace(/[\t\n\r]/gu, "")),
  v.url(),
);
