import { beforeEach, expect, it, vi } from "vitest";
import type { LearningAttempt, Scope, SpanLessonSnapshot } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { getSpanProblem, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { learningObservation } from "../../../../../../../packages/domain/src/opening/learning-summary-fixtures";
const mocks = vi.hoisted(() => ({ decisions: vi.fn(), getAttempt: vi.fn(), get: vi.fn(), agendaGet: vi.fn(), matchesRetestReference: vi.fn(), latest: vi.fn(), create: vi.fn(), save: vi.fn(), deliveredHintLevels: vi.fn(), listByActivity: vi.fn(), heads: vi.fn(), listDeliveredExposures: vi.fn(), intent: vi.fn(), originChange: vi.fn() }));
vi.mock("@aistudy/database", async original => ({
  spanTutorReceiptDecision: (await original<typeof import("@aistudy/database")>()).spanTutorReceiptDecision,
  createOpeningLearningDecisionsRepository: () => ({ list: mocks.decisions }),
  createOpeningSpanSessionRepository: () => mocks,
  createOpeningLearningAgendaRepository: () => ({ get: mocks.agendaGet }),
  createOpeningLearningAttemptRepository: () => ({ ...mocks, get: mocks.getAttempt }),
  createOpeningLearningRepository: () => mocks,
  readOpeningCourseObservationHeads: mocks.heads,
  createOpeningStudyIntentRepository: () => ({ latest: mocks.intent }),
  readOpeningSpanTutorOriginChange: mocks.originChange,
}));
import { createSpanLessonSessionService } from "./lesson-session-service";
import { spanLessonDetailsSchema } from "./span-session-client";
const taskReads = vi.hoisted(() => ({ listTasks: vi.fn() }));
vi.mock("../../planning/plan-service", () => ({ createOpeningPlanService: () => taskReads }));
const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const scope: Scope = { workspaceId: id, ownerUserId: id };
const session: SpanLessonSnapshot = { activityId: id, sessionId: id, courseId: id, sourceIds: [id], intent: { purpose: "self_study", timeBudgetMinutes: 20, pace: "normal", language: "zh", continuous: true, selfReportedFatigue: "unknown" }, moveId: "self-independent", status: "paused", revision: 4, retestId: null, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" };
const attempt: LearningAttempt = { id, workspaceId: id, sessionId: id, courseId: id, skillLabel: "span", requirementKey: null, historyRevision: 0, sourceIds: [id], sourceVersions: { [id]: 1 }, problemId: id, itemVersionId: id, spanExercise: getSpanProblem("span-independent-3d")!, startedAt: session.createdAt, submittedAt: null, observationId: null };
beforeEach(() => { vi.clearAllMocks(); taskReads.listTasks.mockResolvedValue([]); mocks.decisions.mockResolvedValue([]); mocks.matchesRetestReference.mockResolvedValue(false); mocks.get.mockResolvedValue(session); mocks.agendaGet.mockResolvedValue(null); mocks.latest.mockResolvedValue(session); mocks.listByActivity.mockResolvedValue([]); mocks.heads.mockResolvedValue([]); mocks.deliveredHintLevels.mockResolvedValue({}); mocks.listDeliveredExposures.mockResolvedValue([]); mocks.intent.mockResolvedValue(null); mocks.originChange.mockResolvedValue(undefined); });
const service = () => createSpanLessonSessionService({} as Sql);
function targetedOrigin() {
  const origin = { ...learningObservation, sessionId: other, courseId: id, attemptId: id, problemId: id, itemVersionId: id,
    sourceIds: [id], sourceVersions: { [id]: 1 }, effectiveHeadId: learningObservation.id,
    answer: JSON.stringify({ membership: "in_span", coefficients: ["2", "1"] }),
    serverEvaluation: { observationId: learningObservation.id, attemptId: id, problemId: id, itemVersionId: id,
      requirementKey: SPAN_REQUIREMENT_KEY, evaluatorVersion: "span-exact-v1", specVersion: "span-v1",
      decision: "incorrect", outcome: "incorrect", evaluatedAt: session.createdAt, reasonCodes: ["membership_incorrect"],
      skills: { equation: "unobserved", coefficients: "incorrect", allCoordinates: "unobserved" } } };
  mocks.heads.mockResolvedValue([origin]);
  mocks.get.mockImplementation(async (_scope, key) => key === id ? { ...session, status: "active", moveId: "self-example" } : null);
  mocks.decisions.mockResolvedValue([{ policyVersion: "next-learning-step-2/span-tutor-execution-2",
    intentVersion: JSON.stringify({ ruleDecision: { activityKind: "targeted_explain", focusObservationId: origin.id }, sourceRefs: [{ sourceId: id, sourceVersion: 1 }] }) }]);
  return origin;
}
it("reads the original third-coordinate error from the receipt without exposing a solution, including on return", async () => {
  targetedOrigin();
  // The focus is from another session, not this derived activity's attempts.
  mocks.getAttempt.mockResolvedValue({ ...attempt, sessionId: other });
  for (let i = 0; i < 2; i++) {
    const details = spanLessonDetailsSchema.parse(await service().read(scope, id, id));
    expect(details.targetedFocus).toBe("系数代入后，第3坐标没对上。");
    expect(details.attempts).toEqual([]);
  }
  expect(mocks.getAttempt).toHaveBeenCalledWith(scope, id);
  expect(mocks.save).not.toHaveBeenCalled();
});
it.each(["regraded", "retracted", "not_head", "source_changed", "missing_question", "full_explain", "unknown_version"])("hides targeted focus for %s", async reason => {
  const origin = targetedOrigin(); mocks.getAttempt.mockResolvedValue({ ...attempt, sessionId: other });
  if (reason === "regraded") mocks.heads.mockResolvedValue([{ ...origin, id: other, effectiveHeadId: other }]);
  if (reason === "retracted") mocks.heads.mockResolvedValue([{ ...origin, revisionKind: "retract" }]);
  if (reason === "not_head") mocks.heads.mockResolvedValue([{ ...origin, effectiveHeadId: other }]);
  if (reason === "source_changed") mocks.originChange.mockResolvedValue({ reason: "source_unavailable", originSession: null, observationId: null });
  if (reason === "missing_question") mocks.getAttempt.mockResolvedValue({ ...attempt, spanExercise: undefined });
  if (reason === "unknown_version") mocks.heads.mockResolvedValue([{ ...origin, sourceVersions: null }]);
  if (reason === "full_explain") mocks.decisions.mockResolvedValue([{ policyVersion: "next-learning-step-2/span-tutor-execution-2", intentVersion: JSON.stringify({ ruleDecision: { activityKind: "full_explain", focusObservationId: origin.id } }) }]);
  expect(spanLessonDetailsSchema.parse(await service().read(scope, id, id)).targetedFocus).toBeUndefined();
});
it.each([
  ["equation", { equation: { vectors: [["1", "1", "0"], ["0", "1", "1"]], target: ["2", "3", "9"] } }, "向量等式没对上"],
  ["allCoordinates", { coordinateChecks: ["2", "3", "2"] }, "逐坐标验算有误"],
  ["noSolutionProof", { membership: "not_in_span", noSolutionWitness: ["1", "0", "0"] }, "无解理由不成立"],
  ["geometry", { representations: { geometry: "line" } }, "几何表征没对上"],
  ["systemConsistency", { representations: { system: "unique" } }, "方程组表征没对上"],
] as const)("describes the exact original %s error without solution values", async (skill, answer, label) => {
  const origin = targetedOrigin();
  mocks.heads.mockResolvedValue([{ ...origin, answer: JSON.stringify({ membership: "in_span", coefficients: ["2", "1"], ...answer }),
    serverEvaluation: { ...origin.serverEvaluation, skills: { equation: "unobserved", coefficients: "unobserved", allCoordinates: "unobserved", [skill]: "incorrect" } } }]);
  mocks.getAttempt.mockResolvedValue({ ...attempt, sessionId: other });
  const result = await service().read(scope, id, id);
  expect(result.targetedFocus).toBe(`${label}，第3坐标没对上。`);
});
it("uses only the exact bound activity task estimate, not course siblings or the session budget", async () => {
  taskReads.listTasks.mockResolvedValue([{ courseId: id, estimateMinutes: 25, teachingTarget: { courseId: id, activityId: id } }]);
  expect(spanLessonDetailsSchema.parse(await service().read(scope, id, id)).estimateMinutes).toBe(25);
  taskReads.listTasks.mockResolvedValue([{ courseId: id, estimateMinutes: 25, teachingTarget: { courseId: id, activityId: other } }]);
  expect(spanLessonDetailsSchema.parse(await service().read(scope, id, id)).estimateMinutes).toBeNull();
});
it("recovers only the exact activity's shared session and effective facts without rewriting first-answer help", async () => {
  const original = { ...learningObservation, courseId: id, sessionId: id, attemptId: id, assistance: "independent" as const };
  mocks.listByActivity.mockResolvedValue([{ ...attempt, outcome: "correct", assistance: "independent" }, { ...attempt, id: other, sessionId: other }]);
  mocks.heads.mockResolvedValue([original, { ...original, id: other, sessionId: other }, { ...original, id: other, revisionKind: "retract" }]);
  mocks.listDeliveredExposures.mockResolvedValue(["hinted", "revealed"]);
  mocks.deliveredHintLevels.mockResolvedValue({ [id]: [1, 4] });
  const details = await service().read(scope, id, id);
  expect(details.agenda).toBeNull();
  const result = spanLessonDetailsSchema.parse(details);
  expect(mocks.agendaGet).toHaveBeenCalledExactlyOnceWith(scope, session.courseId, session.activityId);
  expect(result.attempts).toHaveLength(1); expect(result.attempts[0]).not.toHaveProperty("outcome");
  expect(result.observations).toEqual([expect.objectContaining({ id: original.id, assistance: "independent" })]);
  expect(result.assistance).toEqual({ [id]: "revealed" }); expect(result.hintLevels).toEqual({ [id]: [1, 4] });
  expect(mocks.listByActivity).toHaveBeenCalledWith(scope, id); expect(mocks.listDeliveredExposures).toHaveBeenCalledWith(scope, id, { attemptId: id, assessmentDomain: "math" });
});
it("rejects a lesson from another course or retest before reading its answers", async () => {
  await expect(service().read(scope, other, id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(service().read(scope, id, id, other)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(mocks.listByActivity).not.toHaveBeenCalled(); expect(mocks.heads).not.toHaveBeenCalled();
  expect(mocks.agendaGet).not.toHaveBeenCalled();
});
it("keeps the no-session entry read-only and ordinary/retest discovery separate", async () => {
  mocks.latest.mockResolvedValue(null);
  expect(await service().read(scope, id)).toMatchObject({ session: null, attempts: [], observations: [], hintLevels: {} });
  expect(mocks.latest).toHaveBeenLastCalledWith(scope, id, null);
  await service().read(scope, id, undefined, other);
  expect(mocks.latest).toHaveBeenLastCalledWith(scope, id, other); expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.agendaGet).not.toHaveBeenCalled();
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
it("returns the current origin snapshot while retaining the derived lesson's actual history", async () => {
  const currentOrigin = { ...session, activityId: other, sessionId: other, revision: 9, status: "completed" };
  mocks.originChange.mockResolvedValue({ reason: "evidence_changed", originSession: currentOrigin, observationId: other });
  mocks.listByActivity.mockResolvedValue([attempt]);
  const result = await service().read(scope, id, id);
  expect(result).toMatchObject({ session, originChange: { reason: "evidence_changed", originSession: { activityId: other, revision: 9 }, observationId: other } });
  expect(result.attempts[0]?.id).toBe(attempt.id);
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
