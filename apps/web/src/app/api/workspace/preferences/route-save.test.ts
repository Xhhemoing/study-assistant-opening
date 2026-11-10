import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ runtime: vi.fn(), principal: vi.fn(), learning: vi.fn(), entry: vi.fn() }));
vi.mock("../../../../server/runtime", () => ({ getAuthRuntime: mocks.runtime }));
vi.mock("../../../../features/auth/service", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../features/auth/service")>(),
  requirePrincipal: mocks.principal,
  setLearningPreferencesForPrincipal: mocks.learning,
  setWorkspacePreferenceForPrincipal: mocks.entry,
}));
import { PUT } from "./route";
const preferences = { autoGradeOnSave: true, assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.runtime.mockReturnValue({}); mocks.principal.mockResolvedValue({}); mocks.learning.mockResolvedValue(preferences);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
function request(signal?: AbortSignal) {
  return new Request("http://localhost/api/workspace/preferences", { method: "PUT", signal,
    body: JSON.stringify({ learningPreferences: preferences }), headers: { "content-type": "application/json" } });
}
it("reports an aborted body read as a structured error without writing preferences", async () => {
  const controller = new AbortController(), input = request(controller.signal);
  controller.abort();
  vi.spyOn(input, "json").mockRejectedValue(new DOMException("private body sentinel", "AbortError"));
  const response = await PUT(input);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "服务暂时无法处理请求，请稍后重试。" } });
  expect(mocks.learning).not.toHaveBeenCalled(); expect(mocks.entry).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith("WORKSPACE_PREFERENCES_PUT", { at: expect.any(String), phase: "body", status: 500, code: "INTERNAL_ERROR", requestAborted: true, saveCompleted: false });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private body sentinel");
});
it("does not pretend an abort after a completed save rolled back the preferences", async () => {
  const controller = new AbortController();
  mocks.learning.mockImplementation(async () => { controller.abort(); return preferences; });
  const response = await PUT(request(controller.signal));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ learningPreferences: preferences });
  expect(mocks.learning).toHaveBeenCalledOnce();
  expect(console.warn).toHaveBeenCalledWith("WORKSPACE_PREFERENCES_PUT", { at: expect.any(String), phase: "response", status: 200, requestAborted: true, saveCompleted: true });
});
it("keeps a database save failure distinct from a transport 502 without leaking driver detail", async () => {
  mocks.learning.mockRejectedValue(Object.assign(new Error("private SQL sentinel"), { code: "55P03" }));
  const response = await PUT(request());
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  expect(console.error).toHaveBeenCalledWith("WORKSPACE_PREFERENCES_PUT", { at: expect.any(String), phase: "save", status: 500, code: "INTERNAL_ERROR", requestAborted: false, saveCompleted: false });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private SQL sentinel");
});
it("returns the default entry only after its save resolves", async () => {
  mocks.entry.mockResolvedValue("learn");
  const response = await PUT(new Request("http://localhost/api/workspace/preferences", { method: "PUT", body: JSON.stringify({ defaultEntry: "learn" }) }));
  expect(await response.json()).toEqual({ defaultEntry: "learn" });
  expect(mocks.entry).toHaveBeenCalledOnce(); expect(mocks.learning).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled();
});
