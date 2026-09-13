import { afterAll, beforeAll, vi } from "vitest";

beforeAll(() => {
  vi.stubGlobal("window", globalThis);
});

afterAll(() => {
  vi.unstubAllGlobals();
});
