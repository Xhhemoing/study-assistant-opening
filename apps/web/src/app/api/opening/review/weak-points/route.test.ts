import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../features/auth/service";

const deps = vi.hoisted(() => ({ requireScope: vi.fn(), readState: vi.fn(), listCourses: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: deps.requireScope }));
vi.mock("../../../../../features/opening/teaching/learner-state-service", () => ({ createLearnerStateReadService: () => ({ read: deps.readState }) }));
import { GET } from "./route";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
beforeEach(() => {
  vi.resetAllMocks();
  deps.requireScope.mockResolvedValue({ scope, sql: {}, runtime: { courses: { listCourses: deps.listCourses } } });
  deps.listCourses.mockResolvedValue([]);
  deps.readState.mockResolvedValue({ dataAsOf: "2026-10-23T00:00:00.000Z", features: [], display: { requirements: [] }, completeness: { total: 0, status: "complete" } });
});

it("uses the authenticated scope despite caller-supplied owner or course selectors", async () => {
  const response = await GET(new Request("http://localhost/api/opening/review/weak-points?ownerUserId=other&workspaceId=other"));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(deps.readState).toHaveBeenCalledExactlyOnceWith(scope, {});
  expect(deps.listCourses).toHaveBeenCalledExactlyOnceWith({ workspaceId: scope.workspaceId });
  await expect(response.json()).resolves.toEqual({ points: [], evaluatedAt: "2026-10-23T00:00:00.000Z", incomplete: false });
});

it("rejects unauthenticated reads before loading any learning data", async () => {
  deps.requireScope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "请先登录", 401));
  expect((await GET(new Request("http://localhost/api/opening/review/weak-points"))).status).toBe(401);
  expect(deps.readState).not.toHaveBeenCalled();
  expect(deps.listCourses).not.toHaveBeenCalled();
});

it("preserves a not-found ownership rejection from the complete reader", async () => {
  deps.readState.mockRejectedValue(new ApiError("NOT_FOUND", "workspace not found", 404));
  const response = await GET(new Request("http://localhost/api/opening/review/weak-points"));
  expect(response.status).toBe(404);
});
