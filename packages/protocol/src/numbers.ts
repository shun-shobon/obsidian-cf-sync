import * as v from "valibot";

export const integerSchema = v.pipe(v.number(), v.safeInteger());

export const nonNegativeIntegerSchema = v.pipe(integerSchema, v.minValue(0));
