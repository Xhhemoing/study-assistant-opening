import { beforeEach, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({ next: vi.fn(), gate: vi.fn(), scope: vi.fn() }));
vi.mock("../../../../../../server/opening-config", () => ({ teachingLoopApiDenied: seam.gate }));
vi.mock("../../../../../../features/opening/runtime", () => ({ requireOpeningScope: seam.scope }));
vi.mock("../../../../../../features/opening/teaching/span/next-action-service", () => ({ createSpanNextActionService: () => ({ next: seam.next }) }));
import { ApiError } from "../../../../../../features/auth/service";
import { POST } from "./route";
const scope = { workspaceId: "workspace", ownerUserId: "owner" }, body = { activityId: "activity", expectedRevision: 1, observationId: null, clientKey: "same-request" };
const request = () => new Request("http://localhost/api/opening/teaching/span/next", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); seam.scope.mockResolvedValue({ scope, sql: {} }); seam.gate.mockReturnValue(null); seam.next.mockResolvedValue({ kind: "choice", reason: "unknown_evidence" }); });
it("returns the authenticated service result without caching a continuation", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ kind: "choice", reason: "unknown_evidence" });
  expect(seam.next).toHaveBeenCalledWith(scope, body);
});
it("does not perform a continuation for an unauthenticated request or closed rollout", async () => {
  seam.scope.mockRejectedValueOnce(new ApiError("UNAUTHENTICATED", "请登录", 401));
  expect((await POST(request())).status).toBe(401);
  seam.gate.mockReturnValue(Response.json({ error: { code: "UNAVAILABLE" } }, { status: 403 }));
  expect((await POST(request())).status).toBe(403);
  expect(seam.next).not.toHaveBeenCalled();
});
