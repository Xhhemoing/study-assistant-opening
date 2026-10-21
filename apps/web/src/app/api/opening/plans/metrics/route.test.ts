import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { read, requireScope } = vi.hoisted(() => ({ read: vi.fn(), requireScope: vi.fn() }));
vi.mock("@aistudy/database", async original => ({ ...await original<typeof import("@aistudy/database")>(), readOpeningLoopMetrics: read }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: requireScope }));
import { ApiError } from "../../../../../features/auth/service";
import { GET } from "./route";
const scope = { workspaceId: "workspace", ownerUserId: "owner" }, sql = {};
beforeEach(() => { vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "1"); read.mockReset(); requireScope.mockReset();
  requireScope.mockResolvedValue({ scope, sql }); read.mockResolvedValue({ groups: {} }); });
afterEach(() => vi.unstubAllEnvs());
it("requires authentication and does not read metrics for an anonymous caller", async () => {
  requireScope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
  expect((await GET(new Request("http://x/api/opening/plans/metrics"))).status).toBe(401);
  expect(read).not.toHaveBeenCalled();
});
it("keeps basic learning metrics readable when automatic planning is disabled", async () => {
  vi.stubEnv("OPENING_ADAPTIVE_PLANNING", "0");
  const response = await GET(new Request("http://x/api/opening/plans/metrics"));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledWith(sql, scope, { days: 7 });
});
it("defaults to seven days and passes only the authenticated scope", async () => {
  const response = await GET(new Request("http://x/api/opening/plans/metrics?ownerUserId=spoof"));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledWith(sql, scope, { days: 7 });
});
it.each(["0", "91", "1.2", "NaN", ""])("rejects invalid days %s before database work", async days => {
  expect((await GET(new Request(`http://x/api/opening/plans/metrics?days=${days}`))).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
