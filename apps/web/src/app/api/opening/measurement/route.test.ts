import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  scope: { workspaceId: "workspace", ownerUserId: "owner" },
  read: vi.fn(), start: vi.fn(), setStatus: vi.fn(), next: vi.fn(), act: vi.fn(), export: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("../../../../features/opening/runtime", () => ({ requireOpeningScope: deps.authorize }));
vi.mock("../../../../features/opening/measurement/runtime", () => ({ getMeasurementService: () => deps }));

import { ApiError } from "../../../../features/auth/service";
import { GET, PATCH, POST } from "./route";
import { POST as next } from "./attempts/route";
import { POST as act } from "./attempts/[id]/route";
import { GET as exportData } from "./export/route";

const id = "11111111-1111-4111-8111-111111111111";
const request = (path: string, body?: unknown, method = "POST") => new Request(`http://localhost/api/opening/measurement${path}`, body === undefined ? undefined : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("measurement route trust boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deps.authorize.mockResolvedValue({ scope: deps.scope, sql: {} });
    for (const fn of [deps.read, deps.start, deps.setStatus, deps.next, deps.act, deps.export]) fn.mockResolvedValue({ result: "ok" });
  });

  it("authenticates before reading a course and does not cache successful results", async () => {
    const response = await GET(request(`?courseId=${id}`));
    expect(deps.read).toHaveBeenCalledWith(deps.scope, id);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    deps.authorize.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Sign in", 401));
    const denied = await GET(request(`?courseId=${id}`));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(deps.read).toHaveBeenCalledTimes(1);
  });

  it("rejects client-supplied grades, forecasts, and invalid IDs before repository writes", async () => {
    const context = { params: Promise.resolve({ id }) };
    const forged = await act(request("/attempts", { action: "answer", clientKey: "key-12345", answer: "B", outcome: "correct" }), context);
    expect(forged.status).toBe(400);
    const badId = await act(request("/attempts", { action: "skip", clientKey: "key-12345" }), { params: Promise.resolve({ id: "foreign" }) });
    expect(badId.status).toBe(400);
    expect(deps.act).not.toHaveBeenCalled();
    const invalidRead = await GET(request("?courseId=invalid"));
    expect(invalidRead.status).toBe(400);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("routes typed actions with the authenticated owner and preserves conflict outcomes", async () => {
    const input = { courseId: id, unitId: "calculus-parts-v1", clientKey: "key-12345" };
    expect((await POST(request("", input))).status).toBe(200);
    expect(deps.start).toHaveBeenCalledWith(deps.scope, input);
    await PATCH(request("", { trialId: id, status: "paused" }, "PATCH"));
    expect(deps.setStatus).toHaveBeenCalledWith(deps.scope, { trialId: id, status: "paused" });
    deps.next.mockRejectedValue(Object.assign(new Error("复测尚未到时间"), { code: "CONFLICT" }));
    expect((await next(request("/attempts", { trialId: id, clientKey: "next-12345" }))).status).toBe(409);
    const action = { action: "help", kind: "external", clientKey: "external-12345" };
    await act(request(`/attempts/${id}`, action), { params: Promise.resolve({ id }) });
    expect(deps.act).toHaveBeenCalledWith(deps.scope, id, action);
  });

  it("rejects oversized writes and exports only through the scoped repository", async () => {
    const oversized = new Request("http://localhost/api/opening/measurement", { method: "POST", headers: { "content-length": "16385" }, body: "{}" });
    expect((await POST(oversized)).status).toBe(413);
    expect(deps.start).not.toHaveBeenCalled();
    const response = await exportData(request(`/export?courseId=${id}`));
    expect(deps.export).toHaveBeenCalledWith(deps.scope, id);
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="learning-test.json"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
