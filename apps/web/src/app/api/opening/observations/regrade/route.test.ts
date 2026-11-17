import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), snapshot: vi.fn(), prepare: vi.fn(), confirm: vi.fn(), read: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("../../../../../features/opening/learning/explicit-regrade-runtime", () => ({ getExplicitRegradeService: () => mocks }));
import { ApiError } from "../../../../../features/auth/service";
import { GET, POST } from "./route";
import { POST as CONFIRM } from "./confirm/route";
const scope = { workspaceId: "w", ownerUserId: "u" };
const observationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const url = "http://test/api/opening/observations/regrade";
const input = { observationId, expectedHead: observationId, expectedGradingVersion: 0, clientKey: "recovery" };
const write = (body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.scope.mockResolvedValue({ scope, sql: {} });
  mocks.prepare.mockResolvedValue({ kind: "prepared" }); mocks.confirm.mockResolvedValue({ kind: "progress" });
  mocks.read.mockResolvedValue({ kind: "prepared" }); mocks.snapshot.mockResolvedValue({ expectedHead: observationId });
});
it("prepares with 200 and confirms with 202, with no cache or browser lifetime binding", async () => {
  const prepared = await POST(write(input)), confirmed = await CONFIRM(write({ requestId: observationId }));
  expect(prepared.status).toBe(200); expect(confirmed.status).toBe(202);
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(scope, input);
  expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(scope, { requestId: observationId });
  expect(prepared.headers.get("Cache-Control")).toBe("no-store"); expect(confirmed.headers.get("Cache-Control")).toBe("no-store");
});
it("GET reads snapshots or owner recovery selectors only, never prepare/confirm", async () => {
  await GET(new Request(`${url}?observationId=${observationId}`));
  expect(mocks.snapshot).toHaveBeenCalledExactlyOnceWith(scope, observationId);
  const response = await GET(new Request(`${url}?observationId=${observationId}&clientKey=recovery`));
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith(scope, { observationId, clientKey: "recovery" });
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("maps stale snapshots to 409 and auth/domain failures through the existing error boundary", async () => {
  mocks.read.mockResolvedValue({ kind: "conflict" }); mocks.confirm.mockResolvedValue({ kind: "conflict" });
  expect((await GET(new Request(`${url}?observationId=${observationId}&clientKey=recovery`))).status).toBe(409);
  expect((await CONFIRM(write({}))).status).toBe(409);
  mocks.scope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "login required", 401));
  const response = await POST(write(input)); expect(response.status).toBe(401);
  expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(mocks.prepare).not.toHaveBeenCalled();
});
