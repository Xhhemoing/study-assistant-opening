import { beforeEach, expect, it, vi } from "vitest";
const { prepare, gate } = vi.hoisted(() => ({ prepare: vi.fn(), gate: vi.fn() }));
vi.mock("../../../../../../server/opening-config", () => ({ teachingLoopApiDenied: gate }));
vi.mock("../../../../../../features/opening/runtime", () => ({ requireOpeningScope: vi.fn(async () => ({ scope: { workspaceId: "workspace", ownerUserId: "owner" }, sql: {} })) }));
vi.mock("../../../../../../features/opening/teaching/span/session-service", () => ({ createSpanSessionService: () => ({ prepare }) }));
import { POST } from "./route";
beforeEach(() => { prepare.mockReset().mockResolvedValue({ accepted: true }); gate.mockReset().mockReturnValue(null); });
const request = () => new Request("http://localhost/api/opening/teaching/span/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
it("preserves the teaching rollout gate before any session write", async () => {
  gate.mockReturnValue(Response.json({ error: { code: "UNAVAILABLE" } }, { status: 403 }));
  const response = await POST(request());
  expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("no-store"); expect(prepare).not.toHaveBeenCalled();
});
it("does not cache an enabled session receipt", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store"); expect(prepare).toHaveBeenCalledOnce();
});
