import { afterEach, describe, expect, it, vi } from "vitest";
import { openingCapabilitiesResponseSchema, computeBuildConfigDigest } from "@aistudy/config/public";
import { SECRET_ENV_NAMES } from "@aistudy/config";

const requirePrincipal = vi.fn();
vi.mock("../../../../server/runtime", () => ({ getAuthRuntime: () => ({}) }));
vi.mock("../../../../features/auth/service", async (orig) => {
  const actual = await orig<typeof import("../../../../features/auth/service")>();
  return { ...actual, requirePrincipal: (...args: unknown[]) => requirePrincipal(...args) };
});

import { ApiError } from "../../../../features/auth/service";
import { teachingLoopApiDenied } from "../../../../server/opening-config";
import { GET } from "./route";

async function capabilities() {
  const res = await GET(new Request("http://x/api/opening/capabilities"));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  return { text, body: openingCapabilitiesResponseSchema.parse(JSON.parse(text)) };
}

describe("GET /api/opening/capabilities (PR-H)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    requirePrincipal.mockReset();
  });

  it("same code, env A vs env B: capabilities follow server switches and match route authorization", async () => {
    requirePrincipal.mockResolvedValue({ userId: "user-1", workspaceId: "w" });
    for (const [loop, workspace] of [["0", "0"], ["1", "0"], ["1", "1"]] as const) {
      vi.stubEnv("OPENING_TEACHING_LOOP", loop);
      vi.stubEnv("OPENING_TEACHING_WORKSPACE", workspace);
      const { body } = await capabilities();
      expect(body.authenticated).toBe(true);
      expect(body.capabilities.teachingLoop).toEqual({ api: loop === "1", ui: loop === "1" && workspace === "1" });
      // The browser's view never exceeds what the API allows.
      expect(teachingLoopApiDenied("user-1") === null).toBe(body.capabilities.teachingLoop.api);
    }
  });

  it("rollout: per-user capability equals per-user API decision", async () => {
    vi.stubEnv("OPENING_TEACHING_LOOP", "1");
    vi.stubEnv("OPENING_TEACHING_WORKSPACE", "1");
    vi.stubEnv("OPENING_TEACHING_LOOP_ROLLOUT_PERCENT", "50");
    let on = 0;
    for (let i = 0; i < 40; i += 1) {
      requirePrincipal.mockResolvedValue({ userId: `user-${i}`, workspaceId: "w" });
      const { body } = await capabilities();
      expect(teachingLoopApiDenied(`user-${i}`) === null).toBe(body.capabilities.teachingLoop.api);
      if (body.capabilities.teachingLoop.api) on += 1;
    }
    expect(on).toBeGreaterThan(0);
    expect(on).toBeLessThan(40);
  });

  it("anonymous: authenticated=false and the loop closed; digest matches a build with no NEXT_PUBLIC_*", async () => {
    vi.stubEnv("OPENING_TEACHING_LOOP", "1");
    requirePrincipal.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
    const { body } = await capabilities();
    expect(body.authenticated).toBe(false);
    expect(body.capabilities.teachingLoop).toEqual({ api: false, ui: false });
    expect(body.buildConfigDigest).toBe(computeBuildConfigDigest({}));
  });

  it("registration and matrix switches; response carries no secret names or values", async () => {
    requirePrincipal.mockResolvedValue({ userId: "user-1", workspaceId: "w" });
    vi.stubEnv("OPENING_RELEASE", "1");
    vi.stubEnv("OPENING_MATRIX_TRANSFORM_INTERACTIVE", "0");
    vi.stubEnv("AUTH_SECRET", "PRH_DUMMY_SECRET_MARKER_123");
    const { body, text } = await capabilities();
    expect(body.capabilities.registrationOpen).toBe(false);
    expect(body.capabilities.matrixTransformInteractive).toBe(false);
    expect(text).not.toContain("PRH_DUMMY_SECRET_MARKER_123");
    for (const name of SECRET_ENV_NAMES) expect(text).not.toContain(name);
  });
});
