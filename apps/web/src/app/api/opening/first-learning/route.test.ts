import { beforeEach, describe, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({ start: vi.fn(), scope: vi.fn(), firstLearning: {}, plans: {}, settings: {} }));
vi.mock("../../../../features/opening/runtime", () => ({
  requireOpeningScope: seam.scope, getPlanService: () => seam.plans,
}));
vi.mock("../../../../features/opening/server/data-services", () => ({ getFirstLearningService: () => seam.firstLearning, getPlanningSettingsService: () => seam.settings }));
vi.mock("../../../../features/workspace/first-learning-service", () => ({ startFirstLearning: seam.start }));
import { ApiError } from "../../../../features/auth/service";
import { POST } from "./route";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const request = (body: string, extra = {}) => new Request("http://localhost/api/opening/first-learning",
  { method: "POST", headers: { "content-type": "application/json", ...extra }, body });
beforeEach(() => {
  vi.clearAllMocks(); seam.scope.mockResolvedValue({ scope, sql: {} });
  seam.start.mockResolvedValue({ activityId: "activity", taskId: "task" });
});
describe("first-learning boundary", () => {
  it("uses the authenticated scope and prevents response caching", async () => {
    const response = await POST(request('{"topic":"矩阵"}'));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(seam.start).toHaveBeenCalledWith({ firstLearning: seam.firstLearning, plans: seam.plans, settings: seam.settings }, scope, { topic: "矩阵" });
  });
  it("does not read or write unauthenticated input", async () => {
    seam.scope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "请登录", 401));
    expect((await POST(request("{}"))).status).toBe(401);
    expect(seam.start).not.toHaveBeenCalled();
  });
  it.each([["{broken", {}], ["{}", { "content-length": "16385" }]])("rejects malformed or oversized bodies", async (body, headers) => {
    const response = await POST(request(body, headers));
    expect([400, 413]).toContain(response.status);
    expect(seam.start).not.toHaveBeenCalled();
  });
  it("propagates partial setup failure instead of returning a successful activity", async () => {
    seam.start.mockRejectedValue(new Error("database unavailable"));
    expect((await POST(request("{}"))).status).toBe(500);
  });
});
