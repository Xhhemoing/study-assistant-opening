import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  quota: { maxBytes: 1234, maxObjects: 3 },
  repository: { bind: vi.fn() },
  createRepository: vi.fn(),
  putObject: vi.fn().mockResolvedValue(undefined),
  finalKey: vi.fn((sourceId: string, version: number) => `opening/sources/${sourceId}/v${version}`),
}));
vi.mock("@aistudy/database", () => ({
  createOpeningExamIntegrationRepository: deps.createRepository,
  createOpeningBudgetRepository: vi.fn(), createOpeningExamSprintRepository: vi.fn(),
  createOpeningExamForecastRepository: vi.fn(), createOpeningExamReviewsRepository: vi.fn(),
}));
vi.mock("@aistudy/config", () => ({ loadOpeningUploadQuota: () => deps.quota, loadOpeningModelCatalog: vi.fn() }));
vi.mock("../../../../../worker/src/runtime/model-gateway", () => ({ createDbModelGateway: vi.fn(), scopeBudget: vi.fn() }));
vi.mock("../../../../../worker/src/runtime/source-page-images", () => ({
  createSourcePageImages: vi.fn(), openingPageStorage: () => ({ finalKey: deps.finalKey, putObject: deps.putObject }),
}));
vi.mock("./review-service", () => ({ createExamPhotoReviewService: vi.fn() }));

import { getExamIntegrationService } from "./runtime";
import { examSprintCommandSchema, type ExamSprintOverview } from "@aistudy/contracts";
import { applyExamSprintCommand, createExamSprintState, examSprintOverview } from "@aistudy/domain";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { createExamSprintClient } from "./client";
import { confirmedSprintLessonRequest, prepareSprintLesson, sprintLessonFetcher } from "./lesson-navigation";
import { overviewSchema } from "./client-schemas";

describe("mock conversion HTTP response to existing client to navigation", () => {
  const now = "2026-11-08T08:00:00.000Z", convertedAt = "2026-11-08T08:01:00.000Z", clientKey = "conversion-http-key";
  function fixture() {
    const pack = EXAM_SPRINT_PACK;
    const state = applyExamSprintCommand(createExamSprintState(now), { action: "start", mode: "mock-a", clientKey: "start-http-key" }, pack, now);
    const before = examSprintOverview(state, pack, now), intent = prepareSprintLesson(before, before.currentAttempt!.question.lessonId, true)!;
    const after = examSprintOverview(applyExamSprintCommand(state, { ...intent, clientKey }, pack, convertedAt), pack, convertedAt);
    return { before, after, intent };
  }
  it("sends only after explicit confirmation and shows the matching persisted receipt only after the HTTP response is parsed", async () => {
    const { before, after, intent } = fixture();
    let resolve!: (response: Response) => void;
    const delayed = new Promise<Response>(done => { resolve = done; });
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(before)).mockReturnValueOnce(delayed);
    const client = createExamSprintClient({ fetcher: sprintLessonFetcher(transport), keyFactory: () => clientKey });
    expect(transport).not.toHaveBeenCalled();
    await client.load();
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
    expect(prepareSprintLesson(client.getSnapshot().overview!, intent.lessonId)).toBeNull();
    const request = { intent }, pending = request;
    const send = client.send(intent);
    expect(confirmedSprintLessonRequest(request, pending, before, client.getSnapshot().overview)).toBeNull();
    resolve(Response.json(after));
    const response = await send;
    expect(response?.state.runs[0]!.conversion).toEqual(after.state.runs[0]!.conversion);
    expect(confirmedSprintLessonRequest(request, pending, response!, client.getSnapshot().overview)?.exposureId).toBe(after.state.runs[0]!.conversion!.exposureId);
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse(String(transport.mock.calls[1]![1]?.body))).toEqual({ ...intent, clientKey });
    expect(JSON.stringify(response)).not.toMatch(/partSnapshot|resultMetadata|correctOptionIds/);
  });
  it.each<[string, (data: ExamSprintOverview) => void]>([
    ["missing conversion", data => { delete data.state.runs[0]!.conversion; }],
    ["missing pack version", data => { Reflect.deleteProperty(data.state.runs[0]!.conversion!, "packVersion"); }],
    ["wrong pack version", data => { data.state.runs[0]!.conversion!.packVersion = "wrong"; }],
    ["wrong run", data => { data.state.runs[0]!.conversion!.runId = "wrong"; }],
    ["wrong attempt", data => { data.state.runs[0]!.conversion!.attemptId = "wrong"; }],
    ["wrong lesson", data => { data.state.runs[0]!.conversion!.lessonId = "wrong"; }],
    ["wrong exposure", data => { data.state.runs[0]!.conversion!.exposureId = "wrong"; }],
    ["missing exposure", data => { data.state.lessonExposures = []; }],
    ["wrong mapping", data => { data.state.runs[0]!.conversion!.mappingVersion = "wrong"; }],
    ["wrong key", data => { data.state.runs[0]!.conversion!.clientKey = "wrong-request-key"; }],
    ["unknown field", data => { Reflect.set(data.state.runs[0]!.conversion!, "untrusted", true); }],
  ])("keeps the original position and the same replay key after malformed success: %s", async (_name, corrupt) => {
    const { before, after, intent } = fixture(), malformed = structuredClone(after);
    corrupt(malformed);
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(before)).mockResolvedValueOnce(Response.json(malformed))
      .mockResolvedValueOnce(Response.json(after)).mockResolvedValueOnce(Response.json(after));
    const keys = vi.fn(() => clientKey), client = createExamSprintClient({ fetcher: sprintLessonFetcher(transport), keyFactory: keys });
    await client.load();
    const request = { intent };
    expect(await client.send(intent)).toBeNull();
    expect(client.getSnapshot().uncertain).toBe(true);
    expect(client.getSnapshot().overview?.activeRun?.id).toBe(before.activeRun!.id);
    expect(confirmedSprintLessonRequest(request, request, before, client.getSnapshot().overview)).toBeNull();
    const recovered = await client.recover();
    expect(keys).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(transport.mock.calls[3]![1]?.body).toBe(transport.mock.calls[1]![1]?.body);
    expect(confirmedSprintLessonRequest(request, request, recovered!, client.getSnapshot().overview)?.exposureId).toBe(after.state.runs[0]!.conversion!.exposureId);
    expect(client.getSnapshot().uncertain).toBe(false);
  });
  it("preserves an old response's original shape without manufacturing conversion", () => {
    const { before } = fixture();
    expect(overviewSchema.parse(JSON.parse(JSON.stringify(before))).state.runs[0]).toEqual(before.state.runs[0]);
    expect(overviewSchema.parse(before).state.runs[0]).not.toHaveProperty("conversion");
    expect(examSprintCommandSchema.safeParse({ action: "switch_to_teaching", clientKey }).success).toBe(false);
  });
});

describe("exam integration runtime upload quota", () => {
  it("passes configured quota to admissions and writes the original bytes to the final source key", async () => {
    deps.createRepository.mockReturnValue(deps.repository);
    const sql = {} as Sql;
    expect(getExamIntegrationService(sql)).toBe(deps.repository);
    const [passedSql, , options] = deps.createRepository.mock.calls[0]!;
    expect(passedSql).toBe(sql);
    expect(options.quota).toBe(deps.quota);
    const body = Buffer.from("公开串讲", "utf8");
    await options.writePublicSource({ sourceId: "public-source", version: 0, mime: "text/plain", body });
    expect(deps.finalKey).toHaveBeenCalledWith("public-source", 0);
    expect(deps.putObject).toHaveBeenCalledWith("opening/sources/public-source/v0", body, { mime: "text/plain" });
  });
});
