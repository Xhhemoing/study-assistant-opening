import { spanLessonCreateInputSchema, spanLessonSaveInputSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import { createOpeningSpanSessionRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningStudyIntentRepository, readOpeningCourseObservationHeads } from "@aistudy/database";
import type { Sql } from "postgres";

export function createSpanLessonSessionService(sql: Sql) {
  const sessions = createOpeningSpanSessionRepository(sql);
  return {
    create: (scope: Scope, input: unknown) => sessions.create(scope, spanLessonCreateInputSchema.parse(input)),
    save: (scope: Scope, activityId: string, input: unknown) => sessions.save(scope, uuidSchema.parse(activityId), spanLessonSaveInputSchema.parse(input)),
    async read(scope: Scope, courseIdRaw: string, activityIdRaw?: string | null, retestIdRaw?: string | null) {
      const courseId = uuidSchema.parse(courseIdRaw);
      const session = activityIdRaw ? await sessions.get(scope, uuidSchema.parse(activityIdRaw))
        : await sessions.latest(scope, courseId, retestIdRaw ? uuidSchema.parse(retestIdRaw) : null);
      if (activityIdRaw && (!session || session.courseId !== courseId || session.retestId !== (retestIdRaw ?? null))) {
        throw Object.assign(new Error("本次学习不属于当前课程或复测任务。"), { code: "NOT_FOUND" });
      }
      if (!session) return { session: null, attempts: [], observations: [], assistance: {}, hintLevels: {}, intentEvent: null };
      const [rows, heads, hintLevels, intentEvent] = await Promise.all([
        createOpeningLearningAttemptRepository(sql).listByActivity(scope, session.activityId),
        readOpeningCourseObservationHeads(sql, scope, courseId),
        sessions.deliveredHintLevels(scope, session.activityId),
        createOpeningStudyIntentRepository(sql).latest(scope, session.sessionId),
      ]);
      const attempts = rows.filter(row => row.sessionId === session.sessionId && row.spanExercise).map(({ outcome: _outcome, assistance: _assistance, ...attempt }) => attempt);
      const learning = createOpeningLearningRepository(sql);
      const assistance = Object.fromEntries(await Promise.all(attempts.map(async attempt => {
        const levels = await learning.listDeliveredExposures(scope, session.sessionId, { attemptId: attempt.id, assessmentDomain: "math" });
        return [attempt.id, levels.includes("revealed") ? "revealed" : levels.includes("hinted") ? "hinted" : "none"];
      })));
      return { session, attempts, observations: heads.filter(row => row.sessionId === session.sessionId && row.revisionKind !== "retract"), assistance, hintLevels, intentEvent };
    },
  };
}
