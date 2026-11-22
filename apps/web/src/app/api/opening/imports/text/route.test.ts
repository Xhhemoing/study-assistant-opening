import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpeningSourceError, OpeningStorageError } from "@aistudy/database";
import { POST } from "./route";

const deps = vi.hoisted(() => ({
  scope: { workspaceId: "5d884393-cdef-43a0-9004-f3fc6f48bada", ownerUserId: "a0ec7242-238a-42fb-97f7-44a97ffef6de" },
  sql: vi.fn(), captureSource: vi.fn(), reissueUploadTicket: vi.fn(), beginUpload: vi.fn(), putStaging: vi.fn(), completeCaptureUpload: vi.fn(), schedule: vi.fn(),
}));
vi.mock("../../../../../features/opening/runtime", () => ({
  requireOpeningScope: vi.fn(async () => ({ scope: deps.scope, sql: deps.sql,
    principal: { workspaceId: deps.scope.workspaceId, userId: deps.scope.ownerUserId } })),
}));
vi.mock("../../../../../features/opening/sources/source-service", () => ({ createOpeningSourceService: () => deps }));
vi.mock("../../../../../features/opening/imports-text/retell-task", () => ({
  finishCapture: deps.schedule,
}));

const post = (body: string, headers?: HeadersInit) => POST(new Request("http://localhost/api/opening/imports/text", {
  method: "POST", body, headers,
}));
beforeEach(() => {
  vi.resetAllMocks();
  deps.captureSource.mockResolvedValue({ id: "source", uploadState: "pending" });
  deps.beginUpload.mockResolvedValue({ source: { id: "source" } });
  deps.completeCaptureUpload.mockResolvedValue({ source: { id: "source", name: "归纳.md", bytes: 24 }, replayed: false });
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
    expect(deps.captureSource).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it("authenticates and uploads the exact UTF-8 bytes before scheduling", async () => {
    const body = { content: "# 归纳\r\n1. 验证起点\u0000", clientKey: "第一次", timeZone: "Asia/Shanghai" };
    const response = await post(JSON.stringify(body));
    const bytes = new TextEncoder().encode("# 归纳\n1. 验证起点\n");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sourceId: "source", keySteps: ["验证起点"], taskId: "task", deferredBehindActiveRetest: true });
    const [principal, input, capture] = deps.captureSource.mock.calls[0]!;
    expect(capture.intent).toEqual({ inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/), courseId: null, scheduleNextDayRetell: true, title: "归纳", timeZone: body.timeZone });
    expect(principal.userId).toBe(deps.scope.ownerUserId);
    expect(input).toMatchObject({ name: "归纳.md", mime: "text/markdown", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(deps.putStaging).toHaveBeenCalledWith(principal, "source", { contentType: input.mime, bytes });
    expect(deps.completeCaptureUpload).toHaveBeenCalledWith(principal, "source");
    expect(deps.reissueUploadTicket).toHaveBeenCalledBefore(deps.putStaging);
    expect(deps.putStaging).toHaveBeenCalledBefore(deps.completeCaptureUpload);
    expect(deps.completeCaptureUpload).toHaveBeenCalledBefore(deps.schedule);
    expect(deps.schedule).toHaveBeenCalledWith(deps.sql, deps.scope, expect.objectContaining({ timeZone: body.timeZone }));
  });

  it("saves only the source when scheduling is disabled", async () => {
    deps.schedule.mockResolvedValue(null);
    const result = await post(JSON.stringify({ content: "资料", scheduleNextDayRetell: false }));
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ taskId: null, notBefore: null, deferredBehindActiveRetest: false });
    expect(deps.schedule).toHaveBeenCalledWith(deps.sql, deps.scope, expect.objectContaining({ scheduleNextDayRetell: false }));
  });

  it("recovers the same uploaded source after a lost response; rejects a nonmatching replay", async () => {
    const body = JSON.stringify({ content: "资料", clientKey: "arbitrary-key" });
    await post(body);
    const uploadId = deps.captureSource.mock.calls[0]![1].uploadId;
    deps.captureSource
      .mockResolvedValueOnce({ id: uploadId, uploadState: "uploaded", name: "资料.md", bytes: 7 })
      .mockRejectedValueOnce(new OpeningSourceError("CONFLICT", "capture changed"));
    deps.schedule.mockResolvedValue({ taskId: uploadId, replayed: true, deferredBehindActiveRetest: true });
    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ sourceId: uploadId, taskId: uploadId, deferredBehindActiveRetest: true });
    expect(deps.captureSource.mock.calls[1]![1].uploadId).toBe(uploadId);
    expect((await post(JSON.stringify({ content: "不同资料", clientKey: "arbitrary-key" }))).status).toBe(409);
    expect(deps.putStaging).toHaveBeenCalledTimes(1);
    expect(deps.schedule).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("reserves one upload when opposite intents reach reservation together (first=%s)", async firstFlag => {
    const body = (flag: boolean) => JSON.stringify({ content: "资料", clientKey: "intent-key", scheduleNextDayRetell: flag });
    const uploads = new Map<string, "pending" | "uploaded">();
    // Let both requests finish any pre-checks before either reservation returns.
    let release!: () => void;
    const bothEntered = new Promise<void>(resolve => { release = resolve; });
    let arrivals = 0;
    deps.captureSource.mockImplementation(async (_principal, input, capture) => {
      if (++arrivals === 2) release();
      await bothEntered;
      if (uploads.has(capture.oppositeUploadId)) {
        throw new OpeningSourceError("CONFLICT", "upload intent unavailable");
      }
      if (!uploads.has(input.uploadId)) uploads.set(input.uploadId, "pending");
      return { id: input.uploadId, uploadState: uploads.get(input.uploadId) };
    });
    deps.completeCaptureUpload.mockImplementation(async (_principal, id: string) => {
      uploads.set(id, "uploaded");
      return { source: { id, name: "资料.md", bytes: 7 }, replayed: false };
    });

    deps.schedule.mockImplementation(async (_sql, _scope, input) => input.scheduleNextDayRetell
      ? { taskId: input.sourceId, replayed: true } : null);

    const flags = [firstFlag, !firstFlag];
    const responses = await Promise.all(flags.map(flag => post(body(flag))));
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(uploads.size).toBe(1);
    const winner = responses.findIndex(response => response.status === 201);
    const first = await responses[winner]!.json();
    const retry = await post(body(flags[winner]!));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ sourceId: first.sourceId, taskId: first.taskId });
    expect(deps.completeCaptureUpload).toHaveBeenCalledTimes(1);
  });

  it("passes the normalized course into the locked reservation and stops on conflict", async () => {
    const courseId = "9A445539-4069-40EA-A981-EEAFC28B6553";
    deps.captureSource.mockRejectedValue(new OpeningSourceError("CONFLICT", "capture key unavailable"));
    const response = await post(JSON.stringify({ clientKey: "same-key", content: "资料", courseId, scheduleNextDayRetell: false }));
    expect(response.status).toBe(409);
    expect(deps.captureSource.mock.calls[0]![2].intent).toMatchObject({ courseId: courseId.toLowerCase(), scheduleNextDayRetell: false });
    expect(deps.putStaging).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it("propagates a deletion conflict without staging or retrying the reservation", async () => {
    deps.captureSource.mockRejectedValue(new OpeningSourceError("CONFLICT", "deleted capture"));
    expect((await post('{"content":"x","clientKey":"deleted-key"}')).status).toBe(409);
    expect(deps.captureSource).toHaveBeenCalledTimes(1);
    expect(deps.reissueUploadTicket).not.toHaveBeenCalled();
    expect(deps.putStaging).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it.each([true, false])("rechecks a storage NOT_FOUND against completed intent (completed=%s)", async completed => {
    const body = JSON.stringify({ content: "资料", clientKey: "digest-race", scheduleNextDayRetell: false });
    deps.completeCaptureUpload.mockRejectedValue(new OpeningStorageError("NOT_FOUND", "staging gone"));
    deps.captureSource.mockResolvedValueOnce({ id: "source", uploadState: "pending" });
    if (completed) deps.captureSource.mockResolvedValueOnce({ id: "source", uploadState: "uploaded", name: "资料.md", bytes: 7 });
    else deps.captureSource.mockRejectedValueOnce(new OpeningSourceError("CONFLICT", "still pending"));
    deps.schedule.mockResolvedValue(null);
    const result = await post(body);
    expect(result.status).toBe(completed ? 200 : 404);
    expect(deps.captureSource.mock.calls[1]).toEqual([
      ...deps.captureSource.mock.calls[0]!.slice(0, 2),
      { ...deps.captureSource.mock.calls[0]![2], completedOnly: true },
    ]);
    if (!completed) expect(await result.json()).toMatchObject({ error: { message: "staging gone" } });
  });

  it("does not schedule after an incomplete upload", async () => {
    deps.putStaging.mockRejectedValue(new OpeningSourceError("CONFLICT", "staging failed"));
    deps.captureSource.mockResolvedValueOnce({ id: "source", uploadState: "pending" })
      .mockRejectedValueOnce(new OpeningSourceError("CONFLICT", "still pending"));
    expect((await post('{"content":"x"}')).status).toBe(409);
    expect(deps.completeCaptureUpload).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });
});
