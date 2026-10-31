import { beforeEach, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
vi.mock("./auto-grade-policy", () => ({ resolveAutoGradePolicy: async () => ({ enabled: true, modelAvailable: false, dailyCap: 50 }) }));
const mocks = vi.hoisted(() => ({ access: vi.fn(), exposures: vi.fn(), insert: vi.fn(), span: vi.fn(), sql: vi.fn(), knowledge: vi.fn() }));
vi.mock("@aistudy/database", () => ({
  createOpeningLearningAttemptRepository: () => ({ assertAccess: mocks.access }),
  createOpeningLearningRepository: () => ({ listDeliveredExposures: mocks.exposures, insertObservation: mocks.insert }),
  createOpeningKnowledgeRepository: () => ({ get: mocks.knowledge }),
  createOpeningSpanSessionRepository: () => ({ get: mocks.span }),
  readOpeningAttemptGradingUsesVision: async () => false,
}));
import { createOpeningAttemptService } from "./attempt-service";
const id = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: id, ownerUserId: id };
const body = { clientKey: "confidence-submit", answer: "1", outcome: "correct", assistance: "independent" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ id, sessionId: id, courseId: id, sourceIds: [], skillLabel: "fractions", problemId: id, itemVersionId: id });
  mocks.exposures.mockResolvedValue(["hinted"]);
  mocks.span.mockResolvedValue({ sessionId: id });
  mocks.knowledge.mockResolvedValue(null);
  mocks.sql.mockResolvedValue([{ not_before_at: "2020-01-01T00:00:00Z", recommended_at: null, scheduled_start_at: null }]);
});
it.each(["ordinary", "span", "retest"])("carries the original confidence through %s without adding it to ordinary observations", async branch => {
  if (branch === "span") mocks.access.mockResolvedValue({ id, sessionId: id, courseId: id, sourceIds: [], skillLabel: "span", problemId: id, spanExercise: {}, contextAnchor: { activityId: id } });
  await createOpeningAttemptService(mocks.sql as unknown as Sql).submit(scope, id, {
    ...body, preAnswerConfidence: "confident", ...(branch === "retest" ? { retestId: id } : {}),
  });
  expect(mocks.insert).toHaveBeenCalledWith(scope, expect.objectContaining({ answer: "1", assistance: "hinted" }),
    expect.objectContaining({ preAnswerConfidence: "confident", autoGrade: { enabled: true, modelAvailable: false, dailyCap: 50 } }));
  expect(mocks.insert.mock.calls[0]![1]).not.toHaveProperty("preAnswerConfidence");
});
it.each([undefined, null])("keeps skipped confidence absent from legacy options (%s)", async preAnswerConfidence => {
  await createOpeningAttemptService(mocks.sql as unknown as Sql).submit(scope, id, { ...body, preAnswerConfidence });
  expect(mocks.insert.mock.calls[0]![2]).not.toHaveProperty("preAnswerConfidence");
});
it("rejects invalid categories before accessing an attempt", async () => {
  await expect(createOpeningAttemptService(mocks.sql as unknown as Sql).submit(scope, id, { ...body, preAnswerConfidence: 0.9 })).rejects.toThrow();
  expect(mocks.access).not.toHaveBeenCalled();
});
it("prepares the learner's uploaded photo without course membership or an observation", async () => {
  mocks.access.mockResolvedValue({ id, sessionId: id, courseId: id, sourceIds: [], skillLabel: "fractions", problemId: id, itemVersionId: id });
  mocks.sql.mockResolvedValue([{ id, version: 2, mime: "image/jpeg", parse_state: "queued", upload_state: "uploaded" }]);
  await expect(createOpeningAttemptService(mocks.sql as unknown as Sql).preparePhotoWorkSource(scope, id, { sourceId: id, sourceVersion: 2, physicalPage: 1 })).resolves.toMatchObject({
    attemptId: id, courseId: id, state: "pending", workSource: { id, version: 2, physicalPage: 1 },
  });
  expect(mocks.insert).not.toHaveBeenCalled();
  expect(String((mocks.sql.mock.calls.at(-1)![0] as TemplateStringsArray).join("?"))).not.toContain("course_asset_memberships");
});
it("rejects a stale or unavailable photo identity", async () => {
  mocks.access.mockResolvedValue({ id, sessionId: id, courseId: id, sourceIds: [], skillLabel: "fractions", problemId: id, itemVersionId: id });
  mocks.sql.mockResolvedValue([]);
  await expect(createOpeningAttemptService(mocks.sql as unknown as Sql).preparePhotoWorkSource(scope, id, { sourceId: id, sourceVersion: 1, physicalPage: 1 })).rejects.toThrow("版本已过期");
});
