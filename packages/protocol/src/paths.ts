import * as v from "valibot";

const MAX_PATH_BYTES = 974;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const INVALID_CHARACTERS = /[\\<>:"|?*]/;
const CONTROL_CHARACTERS = /\p{Cc}/u;

function isSupportedSegment(segment: string): boolean {
  if (segment.length === 0 || segment.startsWith(".")) {
    return false;
  }

  const hasInvalidEnding = /[. ]$/.test(segment);
  const isReservedName = RESERVED_NAME.test(segment);

  return !hasInvalidEnding && !isReservedName;
}

function isSupportedPath(path: string): boolean {
  if (path.startsWith("/")) {
    return false;
  }

  const hasInvalidCharacters = INVALID_CHARACTERS.test(path);
  const hasControlCharacters = CONTROL_CHARACTERS.test(path);

  if (hasInvalidCharacters || hasControlCharacters) {
    return false;
  }

  return path.split("/").every(isSupportedSegment);
}

export const pathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(1024),
  v.maxBytes(MAX_PATH_BYTES),
  v.check(isSupportedPath, "Unsupported vault path"),
);

export function isExcluded(path: string, exclusions: readonly string[]): boolean {
  const hidden = path.split("/").some((part) => part.startsWith("."));

  if (hidden) {
    return true;
  }

  return exclusions.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function conflictPath(path: string, id: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  let extensionStart = path.length;

  if (dot > slash) {
    extensionStart = dot;
  }

  const stem = path.slice(0, extensionStart);
  const extension = path.slice(extensionStart);

  return `${stem} (conflict ${id})${extension}`;
}
