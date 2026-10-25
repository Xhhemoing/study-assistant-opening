import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  scope: { workspaceId: "workspace", ownerUserId: "owner" },
  authorize: vi.fn(), read: vi.fn(), act: vi.fn(), export: vi.fn(),
}));
vi.mock("../../../../features/opening/runtime", () => ({ requireOpeningScope: deps.authorize }));
vi.mock("../../../../features/opening/exam-sprint/runtime", () => ({ getExamSprintService: () => deps }));
import { ApiError } from "../../../../features/auth/service";
import { GET, POST } from "./route";
import { GET as exportData } from "./export/route";

const request = (body?: unknown) => new Request("http://localhost/api/opening/exam-sprint", body === undefined ? undefined : {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("exam sprint HTTP boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deps.authorize.mockResolvedValue({ scope: deps.scope, sql: {} });
    for (const method of [deps.read, deps.act, deps.export]) method.mockResolvedValue({ ok: true });
  });

  it("authenticates all reads, writes and exports and disables response caching", async () => {
    expect((await GET(request())).headers.get("Cache-Control")).toBe("no-store");
    expect(deps.read).toHaveBeenCalledWith(deps.scope);
    const command = { action: "start", mode: "diagnostic", clientKey: "start-key-1" };
    expect((await POST(request(command))).status).toBe(200);
    expect(deps.act).toHaveBeenCalledWith(deps.scope, command);
    const exported = await exportData(request());
    expect(deps.export).toHaveBeenCalledWith(deps.scope);
    expect(exported.headers.get("Content-Disposition")).toBe('attachment; filename="exam-sprint-records.json"');
    deps.authorize.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Sign in", 401));
    for (const response of [await GET(request()), await POST(request(command)), await exportData(request())]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(deps.act).toHaveBeenCalledTimes(1);
    expect(deps.export).toHaveBeenCalledTimes(1);
  });

  it("rejects supplied scores, owner identities and invalid dates", async () => {
    const answer = { action: "answer", clientKey: "answer-123", attemptId: "attempt", answer: "A", confidence: 4 };
    for (const payload of [{ ...answer, correct: true }, { ...answer, ownerUserId: "someone-else" },
      { action: "configure", clientKey: "config-123", examDate: "2026-02-30", dailyMinutes: 60 },
      { action: "source", clientKey: "source-123", sourceId: "t1-q-1", phase: "first", outcome: "correct", assistance: "none", durationMinutes: -1, errorCause: null, note: "" }]) {
      expect((await POST(request(payload))).status).toBe(400);
    }
    expect(deps.act).not.toHaveBeenCalled();
  });

  it("preserves validation and conflict responses without writing on oversize input", async () => {
    const oversized = new Request("http://localhost/api/opening/exam-sprint", { method: "POST", headers: { "content-length": "32769" }, body: "{}" });
    expect((await POST(oversized)).status).toBe(413);
    expect(deps.act).not.toHaveBeenCalled();
    deps.act.mockRejectedValue(Object.assign(new Error("This command key was already used"), { code: "CONFLICT" }));
    const response = await POST(request({ action: "start", mode: "diagnostic", clientKey: "start-12345" }));
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("accepts only scoped lesson authorization identities and rejects client exposure claims", async () => {
    const command = { action: "open_lesson", clientKey: "lesson-http-1", lessonId: "complex-arithmetic",
      expectedRunId: "run-1", expectedAttemptId: "attempt-1", packVersion: "2026-10-17-v1",
      contentFingerprint: "a".repeat(64), mappingVersion: "reviewed-v1" };
    expect((await POST(request(command))).status).toBe(200);
    expect(deps.act).toHaveBeenCalledWith(deps.scope, command);
    for (const payload of [{ ...command, workspaceId: "other" }, { ...command, displayedFamilyIds: [] },
      { ...command, lessonExposureIds: [] }, { ...command, expectedAttemptId: undefined },
      { ...command, contentFingerprint: undefined }]) {
      expect((await POST(request(payload))).status).toBe(400);
    }
    expect(deps.act).toHaveBeenCalledTimes(1);
  });

  it("returns a service refusal for an unsubmitted mock without content", async () => {
    deps.act.mockRejectedValue(Object.assign(new Error("模拟交卷前不能打开串讲"), { code: "CONFLICT" }));
    const response = await POST(request({ action: "open_lesson", clientKey: "lesson-http-2", lessonId: "complex-arithmetic",
      expectedRunId: "mock-run", expectedAttemptId: "mock-attempt", packVersion: "2026-10-17-v1",
      contentFingerprint: "a".repeat(64), mappingVersion: "reviewed-v1" }));
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).not.toHaveProperty("lessonContents");
  });

});
