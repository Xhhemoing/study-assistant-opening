import { afterEach, expect, it, vi } from "vitest";
import PublicTryPage from "../../../app/try/page";

afterEach(() => vi.unstubAllEnvs());

it("serves an anonymous challenge with the controlled account entry", () => {
  vi.stubEnv("OPENING_PUBLIC_TRY", "1");
  vi.stubEnv("OPENING_RELEASE", "1");
  expect(PublicTryPage().props.entry).toBe("/login");
  vi.stubEnv("OPENING_RELEASE", "0");
  expect(PublicTryPage().props.entry).toBe("/register");
});

it("returns Next's not-found response when the challenge is disabled", () => {
  vi.stubEnv("OPENING_PUBLIC_TRY", "0");
  expect(PublicTryPage).toThrow(expect.objectContaining({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" }));
});
