import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpeningSourceError } from "@aistudy/database";
import { POST } from "./route";

const deps = vi.hoisted(() => ({
  scope: { workspaceId: "5d884393-cdef-43a0-9004-f3fc6f48bada", ownerUserId: "a0ec7242-238a-42fb-97f7-44a97ffef6de" },
  sql: vi.fn(), beginUpload: vi.fn(), putStaging: vi.fn(), completeUpload: vi.fn(), schedule: vi.fn(), course: vi.fn(),
}));
vi.mock("../../../../../features/opening/runtime", () => ({
  requireOpeningScope: vi.fn(async () => ({ scope: deps.scope, sql: deps.sql,
    principal: { workspaceId: deps.scope.workspaceId, userId: deps.scope.ownerUserId } })),
}));
vi.mock("../../../../../features/opening/sources/source-service", () => ({ createOpeningSourceService: () => deps }));
vi.mock("../../../../../features/opening/imports-text/retell-task", () => ({
  requireCaptureCourse: deps.course, scheduleRetell: deps.schedule,
}));

const post = (body: string, headers?: HeadersInit) => POST(new Request("http://localhost/api/opening/imports/text", {
  method: "POST", body, headers,
}));
beforeEach(() => {
  vi.resetAllMocks();
  deps.beginUpload.mockResolvedValue({ source: { id: "source" } });
  deps.completeUpload.mockResolvedValue({ id: "source", name: "归纳.md", bytes: 24 });
  deps.schedule.mockResolvedValue({ taskId: "task", notBefore: "2026-11-22T00:00:01Z", deferredBehindActiveRetest: true });
});

describe("POST /api/opening/imports/text", () => {
  it.each([
    ["1".repeat(256 * 1024 + 1), { "content-length": "2" }, 413],
    ["讲".repeat(90000), {}, 413],
    ["{}", { "content-length": "300000" }, 413],
    ["{", {}, 400], ['{"content":1}', {}, 400], ['{"content":"x","scope":"other"}', {}, 400],
    [JSON.stringify({ content: "\u0000" }), {}, 400], ['{"content":"x","timeZone":"No/Such"}', {}, 400],
    ['{"content":"x","providerHint":"unknown"}', {}, 400],
  ] as const)("rejects invalid input (%#)", async (body, headers, status) => {
    expect((await post(body, headers)).status).toBe(status);
    expect(deps.beginUpload).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it("authenticates and uploads the exact UTF-8 bytes before scheduling", async () => {
    const body = { content: "# 归纳\r\n1. 验证起点\u0000", clientKey: "第一次", timeZone: "Asia/Shanghai" };
    const response = await post(JSON.stringify(body));
    const bytes = new TextEncoder().encode("# 归纳\n1. 验证起点\n");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sourceId: "source", keySteps: ["验证起点"], taskId: "task", deferredBehindActiveRetest: true });
    const [principal, input] = deps.beginUpload.mock.calls[0]!;
    expect(principal.userId).toBe(deps.scope.ownerUserId);
    expect(input).toMatchObject({ name: "归纳.md", mime: "text/markdown", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(deps.putStaging).toHaveBeenCalledWith(principal, "source", { contentType: input.mime, bytes });
    expect(deps.completeUpload).toHaveBeenCalledWith(principal, "source");
    expect(deps.beginUpload).toHaveBeenCalledBefore(deps.putStaging);
    expect(deps.putStaging).toHaveBeenCalledBefore(deps.completeUpload);
    expect(deps.completeUpload).toHaveBeenCalledBefore(deps.schedule);
    expect(deps.schedule).toHaveBeenCalledWith(deps.sql, deps.scope, expect.objectContaining({ timeZone: body.timeZone }));
  });

  it("saves only the source when scheduling is disabled", async () => {
    const result = await post(JSON.stringify({ content: "资料", scheduleNextDayRetell: false }));
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ taskId: null, notBefore: null, deferredBehindActiveRetest: false });
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it("recovers the same uploaded source after a lost response; rejects a nonmatching replay", async () => {
    const body = JSON.stringify({ content: "资料", clientKey: "arbitrary-key" });
    await post(body);
    const uploadId = deps.beginUpload.mock.calls[0]![1].uploadId;
    deps.beginUpload.mockRejectedValue(new OpeningSourceError("CONFLICT", "completed upload"));
    deps.sql.mockResolvedValueOnce([{ id: uploadId }]).mockResolvedValueOnce([]);
    deps.schedule.mockResolvedValue({ taskId: uploadId, replayed: true, deferredBehindActiveRetest: true });
    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ sourceId: uploadId, taskId: uploadId, deferredBehindActiveRetest: true });
    expect(deps.beginUpload.mock.calls[1]![1].uploadId).toBe(uploadId);
    expect((await post(JSON.stringify({ content: "不同资料", clientKey: "arbitrary-key" }))).status).toBe(409);
    expect(deps.putStaging).toHaveBeenCalledTimes(1);
    expect(deps.schedule).toHaveBeenCalledTimes(2);
  });

  it("does not schedule after an incomplete upload", async () => {
    deps.putStaging.mockRejectedValue(new OpeningSourceError("CONFLICT", "staging failed"));
    expect((await post('{"content":"x"}')).status).toBe(409);
    expect(deps.completeUpload).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });
});
