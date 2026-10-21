import { beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, Scope, SpanLessonSnapshot } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { getSpanProblem, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { learningObservation } from "../../../../../../../packages/domain/src/opening/learning-summary-fixtures";
const mocks = vi.hoisted(() => ({ get: vi.fn(), matchesRetestReference: vi.fn(), latest: vi.fn(), create: vi.fn(), save: vi.fn(), deliveredHintLevels: vi.fn(), listByActivity: vi.fn(), heads: vi.fn(), listDeliveredExposures: vi.fn(), intent: vi.fn() }));
vi.mock("@aistudy/database", () => ({
  createOpeningSpanSessionRepository: () => mocks,
  createOpeningLearningAttemptRepository: () => mocks,
  createOpeningLearningRepository: () => mocks,
  readOpeningCourseObservationHeads: mocks.heads,
  createOpeningStudyIntentRepository: () => ({ latest: mocks.intent }),
}));
import { createSpanLessonSessionService } from "./lesson-session-service";
import { spanLessonDetailsSchema } from "./span-session-client";
const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const scope: Scope = { workspaceId: id, ownerUserId: id };
const session: SpanLessonSnapshot = { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent: { purpose: "self_study", timeBudgetMinutes: 20, pace: "normal", language: "zh", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self-independent", status: "paused", revision: 4, retestId: null, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" };
const attempt: LearningAttempt = { id, workspaceId: id, sessionId: id, courseId: id, skillLabel: "span", requirementKey: null, historyRevision: 0, sourceIds: [id], sourceVersions: { [id]: 1 }, problemId: id, itemVersionId: id, spanExercise: getSpanProblem("span-independent-3d")!, startedAt: session.createdAt, submittedAt: null, observationId: null };
beforeEach(() => { vi.clearAllMocks(); mocks.matchesRetestReference.mockResolvedValue(false); mocks.get.mockResolvedValue(session); mocks.latest.mockResolvedValue(session); mocks.listByActivity.mockResolvedValue([]); mocks.heads.mockResolvedValue([]); mocks.deliveredHintLevels.mockResolvedValue({}); mocks.listDeliveredExposures.mockResolvedValue([]); mocks.intent.mockResolvedValue(null); });
const service = () => createSpanLessonSessionService({} as Sql);
it("recovers only the exact activity's shared session and effective facts without rewriting first-answer help", async () => {
  const original = { ...learningObservation, courseId: id, sessionId: id, attemptId: id, assistance: "independent" as const };
  mocks.listByActivity.mockResolvedValue([{ ...attempt, outcome: "correct", assistance: "independent" }, { ...attempt, id: other, sessionId: other }]);
  mocks.heads.mockResolvedValue([original, { ...original, id: other, sessionId: other }, { ...original, id: other, revisionKind: "retract" }]);
  mocks.listDeliveredExposures.mockResolvedValue(["hinted", "revealed"]);
  mocks.deliveredHintLevels.mockResolvedValue({ [id]: [1, 4] });
  const result = spanLessonDetailsSchema.parse(await service().read(scope, id, id));
  expect(result.attempts).toHaveLength(1); expect(result.attempts[0]).not.toHaveProperty("outcome");
  expect(result.observations).toEqual([expect.objectContaining({ id: original.id, assistance: "independent" })]);
  expect(result.assistance).toEqual({ [id]: "revealed" }); expect(result.hintLevels).toEqual({ [id]: [1, 4] });
  expect(mocks.listByActivity).toHaveBeenCalledWith(scope, id); expect(mocks.listDeliveredExposures).toHaveBeenCalledWith(scope, id, { attemptId: id, assessmentDomain: "math" });
});
it("rejects a lesson from another course or retest before reading its answers", async () => {
  await expect(service().read(scope, other, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(service().read(scope, id, id, other)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(mocks.listByActivity).not.toHaveBeenCalled(); expect(mocks.heads).not.toHaveBeenCalled();
});
it("keeps the no-session entry read-only and ordinary/retest discovery separate", async () => {
  mocks.latest.mockResolvedValue(null);
  expect(await service().read(scope, id)).toMatchObject({ session: null, attempts: [], observations: [], hintLevels: {} });
  expect(mocks.latest).toHaveBeenLastCalledWith(scope, id, null);
  await service().read(scope, id, undefined, other);
  expect(mocks.latest).toHaveBeenLastCalledWith(scope, id, other); expect(mocks.create).not.toHaveBeenCalled();
});
it("keeps an unavailable restored span attempt visible to the recovery UI instead of silently issuing another", async () => {
  mocks.listByActivity.mockResolvedValue([{ ...attempt, spanExercise: undefined, requirementKey: SPAN_REQUIREMENT_KEY,
    spanValidation: { eligible: false, firstFamilyExposure: false, reasonCode: "restored_identity_unavailable" } }]);
  const result = await service().read(scope, id, id);
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0]).toMatchObject({ id, spanValidation: { eligible: false, reasonCode: "restored_identity_unavailable" } });
});
it("accepts only a server-resolved durable retest alias for the same stored lesson", async () => {
  mocks.get.mockResolvedValue({ ...session, retestId: id });
  mocks.matchesRetestReference.mockResolvedValue(true);
  expect((await service().read(scope, id, id, other)).session?.retestId).toBe(id);
  expect(mocks.matchesRetestReference).toHaveBeenCalledWith(scope, id, id, other);
});
