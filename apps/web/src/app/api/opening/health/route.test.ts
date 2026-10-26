import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requirePrincipal, runReadinessProbes, runtime } = vi.hoisted(() => ({
  requirePrincipal: vi.fn(),
  runReadinessProbes: vi.fn(),
  runtime: {},
}));
vi.mock("../../../../server/runtime", () => ({ getAuthRuntime: () => runtime }));
vi.mock("../../../../features/auth/service", () => ({
  requirePrincipal,
  mapDomainError: () => ({ status: 401, code: "UNAUTHENTICATED" }),
  jsonError: (error: { status: number; code: string }) => Response.json({ error: error.code }, { status: error.status }),
}));
vi.mock("../../../../../../../scripts/opening-readiness-probes.mjs", () => ({ runReadinessProbes }));
import { GET } from "./route";

beforeEach(() => {
  vi.stubEnv("AISTUDY_COMMIT", "189546c71095820f550bff754836f36e7fa17933");
  vi.stubEnv("AISTUDY_BUILT_AT", "2026-10-25T20:00:00.000Z");
  vi.resetAllMocks();
  runReadinessProbes.mockResolvedValue({ database: { ok: true }, redis: { ok: true }, storage: { ok: true }, workerBacklog: { ok: true } });
});

describe("Opening health visibility", () => {
  it("serves uncached liveness without authentication or dependency probes", async () => {
    const response = await GET(new Request("http://localhost/api/opening/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", commit: "189546c7", builtAt: "2026-10-25T20:00:00.000Z" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(requirePrincipal).not.toHaveBeenCalled();
    expect(runReadinessProbes).not.toHaveBeenCalled();
  });

  it("rejects anonymous detailed probes before accessing dependencies", async () => {
    requirePrincipal.mockRejectedValueOnce(new Error("unauthenticated"));
    const response = await GET(new Request("http://localhost/api/opening/health?details=1"));
    expect(response.status).toBe(401);
    expect(runReadinessProbes).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns dependency failure status only after session authorization", async () => {
    requirePrincipal.mockResolvedValueOnce({ userId: "owner", workspaceId: "workspace" });
    runReadinessProbes.mockResolvedValueOnce({ database: { ok: false }, redis: { ok: true }, storage: { ok: true }, workerBacklog: { ok: true } });
    const request = new Request("http://localhost/api/opening/health?details=1");
    const response = await GET(request);
    expect(requirePrincipal).toHaveBeenCalledWith(runtime, request);
    expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty("status", "down");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

afterEach(() => vi.unstubAllEnvs());
