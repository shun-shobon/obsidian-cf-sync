import { z } from "zod";

const MAX_PATH_BYTES = 974;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function isSupportedSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !segment.startsWith(".") &&
    !/[. ]$/.test(segment) &&
    !RESERVED_NAME.test(segment)
  );
}

function isSupportedPath(path: string): boolean {
  return (
    new TextEncoder().encode(path).byteLength <= MAX_PATH_BYTES &&
    !path.startsWith("/") &&
    !/[\\<>:"|?*]/.test(path) &&
    !/\p{Cc}/u.test(path) &&
    path.split("/").every(isSupportedSegment)
  );
}

export const pathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSupportedPath, "Unsupported vault path");

export function isExcluded(path: string, exclusions: readonly string[]): boolean {
  const hidden = path.split("/").some((part) => part.startsWith("."));
  const excluded = exclusions.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  return hidden || excluded;
}

export function conflictPath(path: string, id: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const split = dot > slash ? dot : path.length;

  return `${path.slice(0, split)} (conflict ${id})${path.slice(split)}`;
}
