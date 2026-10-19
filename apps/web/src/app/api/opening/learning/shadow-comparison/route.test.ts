import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ compare: vi.fn(), requireScope: vi.fn() }));
vi.mock("../../../../../features/opening/teaching/learner-shadow-service", () => ({ createLearnerShadowComparisonService: () => ({ read: deps.compare }) }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: deps.requireScope }));
import { GET } from "./route";
const courseId = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: "22222222-2222-4222-8222-222222222222", ownerUserId: "33333333-3333-4333-8333-333333333333" };
beforeEach(() => { vi.clearAllMocks(); deps.requireScope.mockResolvedValue({ scope, sql: {} }); });
it("takes scope from authentication and returns uncached comparison data", async () => {
  deps.compare.mockResolvedValue({ mode: "shadow", calibrated: false, count: 0 });
  const response = await GET(new Request(`http://localhost/api/opening/learning/shadow-comparison?courseId=${courseId}`));
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(deps.compare).toHaveBeenCalledWith(scope, { courseId });
});
it("rejects model-supplied scope and threshold parameters", async () => {
  const response = await GET(new Request(`http://localhost/api/opening/learning/shadow-comparison?ownerUserId=${courseId}&advanceThreshold=0.1`));
  expect(response.status).toBe(400); expect(deps.compare).not.toHaveBeenCalled();
});
it("does not turn an authorization failure into empty experiment results", async () => {
  const { ApiError } = await import("../../../../../features/auth/service");
  deps.requireScope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "login required", 401));
  const response = await GET(new Request("http://localhost/api/opening/learning/shadow-comparison"));
  expect(response.status).toBe(401); expect(deps.compare).not.toHaveBeenCalled();
});
