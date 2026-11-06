import { beforeEach, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({ cancel: vi.fn(), automatic: vi.fn(), manual: vi.fn(), gate: vi.fn(), scope: vi.fn() }));
vi.mock("../../../../../../../../server/opening-config", () => ({ teachingLoopApiDenied: seam.gate }));
vi.mock("../../../../../../../../features/opening/runtime", () => ({ requireOpeningScope: seam.scope }));
vi.mock("../../../../../../../../features/opening/teaching/span/delayed-retest-service", () => ({
  createSpanDelayedRetestService: () => ({ cancelAutomatic: seam.cancel, scheduleAutomatic: seam.automatic, schedule: seam.manual }),
}));
import { ApiError } from "../../../../../../../../features/auth/service";
import { POST } from "./route";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const body = { activityId: "activity" };
const request = () => new Request("http://localhost/api/opening/teaching/span/delayed/automatic/cancel", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks(); seam.scope.mockResolvedValue({ scope, sql: {} }); seam.gate.mockReturnValue(null);
  seam.cancel.mockResolvedValue({ activityId: "activity", cancelled: false, closedTaskIds: [] });
});
it("returns the owner's undo decision uncached without scheduling anything", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ activityId: "activity", cancelled: false, closedTaskIds: [] });
  expect(seam.cancel).toHaveBeenCalledWith(scope, body);
  expect(seam.automatic).not.toHaveBeenCalled();
  expect(seam.manual).not.toHaveBeenCalled();
});
it("answers a retest that is not the owner's automatic arrangement with not found", async () => {
  seam.cancel.mockRejectedValue(Object.assign(new Error("自动复测不存在。"), { code: "NOT_FOUND" }));
  const response = await POST(request());
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
});
it("does not cancel without an authenticated workspace or behind the closed teaching rollout", async () => {
  seam.scope.mockRejectedValueOnce(new ApiError("UNAUTHENTICATED", "请登录", 401));
  expect((await POST(request())).status).toBe(401);
  seam.gate.mockReturnValue(Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 }));
  const denied = await POST(request());
  expect(denied.status).toBe(404);
  expect(denied.headers.get("cache-control")).toBe("no-store");
  expect(seam.cancel).not.toHaveBeenCalled();
});
