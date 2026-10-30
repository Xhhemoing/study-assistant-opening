import { spanLessonCreateInputSchema, spanLessonSaveInputSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import { createOpeningSpanSessionRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningStudyIntentRepository, readOpeningCourseObservationHeads, readOpeningSpanTutorOriginChange, createOpeningLearningDecisionsRepository, spanTutorReceiptDecision } from "@aistudy/database";
import type { Sql } from "postgres";
import { SPAN_REQUIREMENT_KEY } from "@aistudy/domain";

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
      if (!session) return { session: null, attempts: [], observations: [], assistance: {}, hintLevels: {}, intentEvent: null };
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
      const executionPhase = decision?.phase && decision.phaseSource ? { phase: decision.phase, source: decision.phaseSource } : null;
      const attempts = rows.filter(row => row.sessionId === session.sessionId && (row.spanExercise || row.requirementKey === SPAN_REQUIREMENT_KEY)).map(({ outcome: _outcome, assistance: _assistance, ...attempt }) => attempt);
      const learning = createOpeningLearningRepository(sql);
      const assistance = Object.fromEntries(await Promise.all(attempts.map(async attempt => {
        const levels = await learning.listDeliveredExposures(scope, session.sessionId, { attemptId: attempt.id, assessmentDomain: "math" });
        return [attempt.id, levels.includes("revealed") ? "revealed" : levels.includes("hinted") ? "hinted" : "none"];
      })));
      return { session, executionPhase, attempts, observations: heads.filter(row => row.sessionId === session.sessionId && row.revisionKind !== "retract"), assistance, hintLevels, intentEvent,
        ...(originChange ? { originChange } : {}) };
    },
  };
}
