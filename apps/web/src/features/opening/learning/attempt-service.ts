import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import type { Sql } from "postgres";
export function createOpeningAttemptService(sql: Sql) {
  const attempts = createOpeningLearningAttemptRepository(sql), learning = createOpeningLearningRepository(sql);
  return {
    create(scope: Scope, raw: unknown) { return attempts.create(scope, learningAttemptCreateInputSchema.parse(raw)); },
    async submit(scope: Scope, id: string, raw: unknown) {
      const input = learningAttemptSubmitInputSchema.parse(raw);
      const attempt = await attempts.assertAccess(scope, uuidSchema.parse(id));
      return learning.insertObservation(scope, { ...input, attemptId: attempt.id, sessionId: attempt.sessionId,
        courseId: attempt.courseId, skillLabel: attempt.skillLabel, sourceIds: attempt.sourceIds, problemId: attempt.problemId });
    },
  };
}
