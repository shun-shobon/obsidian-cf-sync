import * as v from "valibot";

export const urlSchema = v.pipe(v.string(), v.url());
