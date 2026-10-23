import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../../../../features/auth/service";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), start: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.auth }));
vi.mock("../../../../../features/opening/practice/photo-recognition-service", () => ({ createPhotoRecognitionService: () => ({ read: mocks.read, start: mocks.start }) }));
import { GET, POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: id, ownerUserId: id };
const result = { sourceId: id, sourceVersion: 0, jobId: null, status: "idle", proposal: null };
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ scope, sql: {} }); mocks.read.mockResolvedValue(result); mocks.start.mockResolvedValue({ ...result, jobId: id, status: "queued" }); });
it("restores an authenticated source/version through a read-only endpoint", async () => {
  const response = await GET(new Request(`http://localhost/api/opening/practice/recognition?sourceId=${id}&sourceVersion=0`));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith(scope, { sourceId: id, sourceVersion: 0 });
  expect(mocks.start).not.toHaveBeenCalled();
});
it("admits recognition only on an explicit authenticated POST", async () => {
  const response = await POST(new Request("http://localhost/api/opening/practice/recognition", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: id, sourceVersion: 0 }) }));
  expect(response.status).toBe(202); expect(mocks.start).toHaveBeenCalledExactlyOnceWith(scope, { sourceId: id, sourceVersion: 0 });
  expect(mocks.read).not.toHaveBeenCalled();
});
it("does not reach source or job access before authentication", async () => {
  mocks.auth.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Sign in", 401));
  expect((await GET(new Request(`http://localhost/api/opening/practice/recognition?sourceId=${id}&sourceVersion=0`))).status).toBe(401);
  expect((await POST(new Request("http://localhost/api/opening/practice/recognition", { method: "POST" }))).status).toBe(401);
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
});
