import { spanLessonCreateInputSchema, spanLessonSaveInputSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import { createOpeningSpanSessionRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningStudyIntentRepository, readOpeningCourseObservationHeads, readOpeningSpanTutorOriginChange, createOpeningLearningAgendaRepository, createOpeningLearningDecisionsRepository, spanTutorReceiptDecision } from "@aistudy/database";
import type { Sql } from "postgres";
import { SPAN_REQUIREMENT_KEY, verifySpanAnswer } from "@aistudy/domain";
import { z } from "zod";
import type { LearningObservation } from "@aistudy/contracts";
import { createOpeningPlanService } from "../../planning/plan-service";

// Captured source refs are checked for current availability by originChange.
const focusReceiptSchema = z.object({ sourceRefs: z.array(z.object({ sourceId: uuidSchema, sourceVersion: z.number().int().nonnegative() })).min(1) });
async function readTargetedFocus(sql: Sql, scope: Scope, observation: LearningObservation, intentVersion: string) {
  const evaluation = observation.serverEvaluation;
  if (evaluation?.evaluatorVersion !== "span-exact-v1" || evaluation.decision !== "incorrect" || !evaluation.skills
    || !observation.attemptId || !observation.itemVersionId || !observation.sourceVersions) return undefined;
  const captured = focusReceiptSchema.safeParse(JSON.parse(intentVersion));
  if (!captured.success || !observation.sourceIds.length || observation.sourceIds.some(id => !captured.data.sourceRefs.some(ref =>
    ref.sourceId === id && ref.sourceVersion === observation.sourceVersions?.[id]))) return undefined;
  const attempt = await createOpeningLearningAttemptRepository(sql).get(scope, observation.attemptId);
  if (!attempt?.spanExercise || attempt.spanValidation?.reasonCode?.startsWith("restored_identity_")
    || attempt.courseId !== observation.courseId || attempt.sessionId !== observation.sessionId || attempt.problemId !== observation.problemId || attempt.itemVersionId !== observation.itemVersionId
    || evaluation.observationId !== observation.id || evaluation.attemptId !== attempt.id || evaluation.itemVersionId !== attempt.itemVersionId
    || observation.sourceIds.some(id => attempt.sourceVersions[id] !== observation.sourceVersions?.[id])) return undefined;
  const verified = verifySpanAnswer(attempt.spanExercise, observation.answer);
  if (verified.outcome === "unknown") return undefined;
  const labels = { equation: "向量等式没对上", coefficients: "系数代入后", allCoordinates: "逐坐标验算有误", noSolutionProof: "无解理由不成立", geometry: "几何表征没对上", systemConsistency: "方程组表征没对上" };
  const skill = (Object.keys(labels) as Array<keyof typeof labels>).find(key => evaluation.skills?.[key] === "incorrect" && verified.skills[key] === "incorrect");
  if (!skill) return undefined;
  const coordinates = verified.failedCoordinates.map(index => index + 1).join("、");
  return `${labels[skill]}${coordinates ? `，第${coordinates}坐标没对上` : skill === "coefficients" ? "没对上" : ""}。`;
}

export function createSpanLessonSessionService(sql: Sql) {
  const sessions = createOpeningSpanSessionRepository(sql);
  return {
    create: (scope: Scope, input: unknown) => sessions.create(scope, spanLessonCreateInputSchema.parse(input)),
    save: (scope: Scope, activityId: string, input: unknown) => sessions.save(scope, uuidSchema.parse(activityId), spanLessonSaveInputSchema.parse(input)),
    async read(scope: Scope, courseIdRaw: string, activityIdRaw?: string | null, retestIdRaw?: string | null) {
      const courseId = uuidSchema.parse(courseIdRaw);
      const session = activityIdRaw ? await sessions.get(scope, uuidSchema.parse(activityIdRaw))
        : await sessions.latest(scope, courseId, retestIdRaw ? uuidSchema.parse(retestIdRaw) : null);
      if (activityIdRaw && (!session || session.courseId !== courseId || (session.retestId !== (retestIdRaw ?? null)
        && !await sessions.matchesRetestReference(scope, courseId, session.retestId, retestIdRaw ?? null)))) {
        throw Object.assign(new Error("本次学习不属于当前课程或复测任务。"), { code: "NOT_FOUND" });
      }
      if (!session) return { session: null, estimateMinutes: null, attempts: [], observations: [], assistance: {}, hintLevels: {}, intentEvent: null };
      const [rows, heads, hintLevels, intentEvent, originChange, decisions] = await Promise.all([
        createOpeningLearningAttemptRepository(sql).listByActivity(scope, session.activityId),
        readOpeningCourseObservationHeads(sql, scope, courseId),
        sessions.deliveredHintLevels(scope, session.activityId),
        createOpeningStudyIntentRepository(sql).latest(scope, session.sessionId),
        readOpeningSpanTutorOriginChange(sql, scope, session.activityId),
        createOpeningLearningDecisionsRepository(sql).list(scope, { layer: "activity", targetId: session.activityId }),
      ]);
      // General practice receipts may be newer. Recover the last executed tutor
      // decision for this activity, never recompute a stage from today's evidence.
      const receipt = decisions.find(row => row.policyVersion.endsWith("/span-tutor-execution-2") || row.policyVersion === "next-learning-step-1/span-tutor-execution-1");
      const decision = spanTutorReceiptDecision(receipt ?? null);
      const focus = !originChange && decision?.activityKind === "targeted_explain" ? heads.find(row => row.id === decision.focusObservationId
        && row.revisionKind !== "retract" && (!row.effectiveHeadId || row.effectiveHeadId === row.id)) : undefined;
      const targetedFocus = focus && receipt ? await readTargetedFocus(sql, scope, focus, receipt.intentVersion) : undefined;
      const executionPhase = decision?.phase && decision.phaseSource ? { phase: decision.phase, source: decision.phaseSource } : null;
      const attempts = rows.filter(row => row.sessionId === session.sessionId && (row.spanExercise || row.requirementKey === SPAN_REQUIREMENT_KEY)).map(({ outcome: _outcome, assistance: _assistance, ...attempt }) => attempt);
      const learning = createOpeningLearningRepository(sql);
      const assistance = Object.fromEntries(await Promise.all(attempts.map(async attempt => {
        const levels = await learning.listDeliveredExposures(scope, session.sessionId, { attemptId: attempt.id, assessmentDomain: "math" });
        return [attempt.id, levels.includes("revealed") ? "revealed" : levels.includes("hinted") ? "hinted" : "none"];
      })));
      const agenda = await createOpeningLearningAgendaRepository(sql).get(scope, session.courseId, session.activityId);
      const tasks = await createOpeningPlanService(sql).listTasks(scope);
      const task = tasks.find(task => task.courseId === courseId && task.teachingTarget?.courseId === courseId && task.teachingTarget.activityId === session.activityId);
      // The estimate describes the bound task, not a per-question time prediction.
      const estimateMinutes = task?.estimateMinutes ?? null;
      return { session, estimateMinutes, agenda, executionPhase, targetedFocus, attempts, observations: heads.filter(row => row.sessionId === session.sessionId && row.revisionKind !== "retract"), assistance, hintLevels, intentEvent,
        ...(originChange ? { originChange } : {}) };
    },
  };
}
