import { afterEach, describe, expect, it, vi } from "vitest";
import { signPitfallShareToken } from "../../../features/opening/share/token-codec";
import OpenGraphImage from "./opengraph-image";

const render = vi.hoisted(() => vi.fn());
vi.mock("next/og", () => ({ ImageResponse: class {
  constructor(_image: unknown, options: ResponseInit) {
    render();
    return new Response(null, options);
  }
} }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), readFileSync: vi.fn(() => Buffer.alloc(0)) }));

const key = "vn9XAJ3yRe8q2kFmK4p7csDgNTW6RhYz";
const card = { subjectLabel: "Math", pitfallTitle: "Signs", trapSummary: "Check the sign", takeawayRule: "Check each term", cohortSampleSize: 0, cohortTrapRate: null, ttlSeconds: 60 };

function image(token: string) {
  return OpenGraphImage({ params: Promise.resolve({ token }) });
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); render.mockClear(); });

describe("share OpenGraph image", () => {
  it("returns 404 without rendering for invalid, expired and invalidated signatures", async () => {
    vi.stubEnv("AUTH_SECRET", key);
    const expired = signPitfallShareToken(card, { nowMs: Date.now() - 61_000 }).token;
    const invalidated = signPitfallShareToken(card, { authSecret: `${key}9` }).token;
    for (const token of ["bad-token", expired, invalidated]) {
      const response = await image(token);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(render).not.toHaveBeenCalled();
  });

  it("caches valid previews briefly and never beyond token expiry", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AUTH_SECRET", key);
    const { token } = signPitfallShareToken(card);
    const fresh = await image(token);
    expect(fresh.headers.get("cache-control")).toBe("public, max-age=30, must-revalidate");
    vi.advanceTimersByTime(57_000);
    const nearExpiry = await image(token);
    expect(nearExpiry.headers.get("cache-control")).toMatch(/^public, max-age=[23], must-revalidate$/);
    expect(render).toHaveBeenCalledTimes(2);
  });
});
