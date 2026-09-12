import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { idSchema, operationResultSchema, operationSchema, pathSchema } from "../src/index";

const opId = "920b5878-2867-47ad-81a8-68cbb2681303";
const fileId = "7ae76e93-bd8c-4e62-8481-3c589ffeb07a";

function deletion(baseRevision: number) {
  return { type: "delete", opId, fileId, baseRevision };
}

describe("wire validation boundaries", () => {
  it.each([NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid operation revision: %s",
    (revision) => {
      expect(v.safeParse(operationSchema, deletion(revision)).success).toBe(false);
    },
  );

  it("keeps valid revisions and strips unknown wire fields", () => {
    const input = { ...deletion(Number.MAX_SAFE_INTEGER), unexpected: "discard" };
    const result = v.parse(operationSchema, input);

    expect(result).toEqual(deletion(Number.MAX_SAFE_INTEGER));
  });

  it.each([
    "12345678-1234-0234-9234-123456789abc",
    "12345678-1234-9234-9234-123456789abc",
    "12345678-1234-4234-1234-123456789abc",
  ])("rejects a non-RFC UUID layout: %s", (value) => {
    expect(v.safeParse(idSchema, value).success).toBe(false);
  });

  it.each([fileId, "00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"])(
    "accepts a valid UUID or reserved value: %s",
    (value) => {
      expect(v.parse(idSchema, value)).toBe(value);
    },
  );

  it("distinguishes nullable acknowledgement fields from an omitted message", () => {
    const result = {
      opId,
      revision: 1,
      previousRevision: null,
      previousPathRevision: null,
      file: null,
      conflict: false,
    };

    expect(v.parse(operationResultSchema, result)).toEqual(result);
    expect(v.safeParse(operationResultSchema, { ...result, message: null }).success).toBe(false);
  });

  it("enforces the R2 path byte budget for multibyte characters", () => {
    const allowed = "日".repeat(323) + ".md";
    const oversized = "日".repeat(324) + ".md";

    expect(v.safeParse(pathSchema, allowed).success).toBe(true);
    expect(v.safeParse(pathSchema, oversized).success).toBe(false);
  });
});
