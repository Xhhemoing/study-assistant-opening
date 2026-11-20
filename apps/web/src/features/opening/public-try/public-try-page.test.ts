import { afterEach, expect, it, vi } from "vitest";
import PublicTryPage from "../../../app/try/page";

afterEach(() => vi.unstubAllEnvs());

const pageProps = { searchParams: Promise.resolve({}) };

it("serves an anonymous challenge with the controlled account entry", async () => {
  vi.stubEnv("OPENING_PUBLIC_TRY", "1");
  vi.stubEnv("OPENING_RELEASE", "1");
  expect((await PublicTryPage(pageProps)).props.entry).toBe("/login");
  vi.stubEnv("OPENING_RELEASE", "0");
  expect((await PublicTryPage(pageProps)).props.entry).toBe("/register");
});

it("returns Next's not-found response when the challenge is disabled", async () => {
  vi.stubEnv("OPENING_PUBLIC_TRY", "0");
  await expect(PublicTryPage(pageProps)).rejects.toThrow(expect.objectContaining({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" }));
});
