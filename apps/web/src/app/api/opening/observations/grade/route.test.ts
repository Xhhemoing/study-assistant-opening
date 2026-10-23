import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), read: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../../../../features/opening/runtime", () => ({ requireOpeningScope: mocks.scope }));
vi.mock("../../../../../features/opening/learning/ai-grading-runtime", () => ({
  getAiGradingService: () => ({ read: mocks.read, enqueue: mocks.enqueue }),
}));
import { ApiError } from "../../../../../features/auth/service";
import { GET, POST } from "./route";
const scope = { workspaceId: "w", ownerUserId: "u" };
const observationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const state = { status: "queued", answerRevision: 1, jobId: "job", rootObservationId: observationId,
  headObservationId: observationId, retryable: false, workSource: null };
beforeEach(() => {
  vi.clearAllMocks(); mocks.scope.mockResolvedValue({ scope, sql: {} });
  mocks.read.mockResolvedValue(state); mocks.enqueue.mockResolvedValue(state);
});
it("returns 202 for durable admission, not a synchronous model grade or browser-linked signal", async () => {
  const controller = new AbortController();
  const response = await POST(new Request("http://test/api/opening/observations/grade", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observationId }), signal: controller.signal,
  }));
  controller.abort();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual(state);
  expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(scope, { observationId });
  expect(mocks.read).not.toHaveBeenCalled();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("polling only reads owner-scoped persisted state and never enqueues", async () => {
  const response = await GET(new Request(`http://test/api/opening/observations/grade?observationId=${observationId}`));
  expect(response.status).toBe(200); expect(await response.json()).toEqual(state);
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith(scope, { observationId });
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("denies unauthenticated reads and writes before repository access", async () => {
  mocks.scope.mockRejectedValue(new ApiError("UNAUTHENTICATED", "login required", 401));
  const read = await GET(new Request(`http://test/api/opening/observations/grade?observationId=${observationId}`));
  const write = await POST(new Request("http://test/api/opening/observations/grade", { method: "POST", body: "{}" }));
  expect(read.status).toBe(401); expect(write.status).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
});
