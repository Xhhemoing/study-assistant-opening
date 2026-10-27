import { beforeEach, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({ automatic: vi.fn(), manual: vi.fn(), gate: vi.fn(), scope: vi.fn() }));
vi.mock("../../../../../../../server/opening-config", () => ({ teachingLoopApiDenied: seam.gate }));
vi.mock("../../../../../../../features/opening/runtime", () => ({ requireOpeningScope: seam.scope }));
vi.mock("../../../../../../../features/opening/teaching/span/delayed-retest-service", () => ({
  createSpanDelayedRetestService: () => ({ scheduleAutomatic: seam.automatic, schedule: seam.manual }),
}));
import { ApiError } from "../../../../../../../features/auth/service";
import { POST } from "./route";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const body = { observationId: "observation", clientKey: "stable-key", expectedGrantRevision: 1 };
const request = () => new Request("http://localhost/api/opening/teaching/span/delayed/automatic", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks(); seam.scope.mockResolvedValue({ scope, sql: {} }); seam.gate.mockReturnValue(null);
  seam.automatic.mockResolvedValue({ taskId: "task", taskStatus: "pending" });
});
it("uses authenticated scope and the versioned automatic service without falling through to manual acceptance", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(seam.automatic).toHaveBeenCalledWith(scope, body);
  expect(seam.manual).not.toHaveBeenCalled();
});
it("preserves the teaching rollout gate before any automatic task write", async () => {
  seam.gate.mockReturnValue(Response.json({ error: { code: "UNAVAILABLE" } }, { status: 403 }));
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(seam.automatic).not.toHaveBeenCalled();
});
it("does not read or accept without an authenticated workspace", async () => {
  seam.scope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "请登录", 401));
  expect((await POST(request())).status).toBe(401);
  expect(seam.automatic).not.toHaveBeenCalled();
});
