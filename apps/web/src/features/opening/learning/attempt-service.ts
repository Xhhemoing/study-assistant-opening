import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository } from "@aistudy/database";
import { resolveAssistance } from "@aistudy/domain";
import type { Sql } from "postgres";

function highestDeliveredAssistance(exposures: ReadonlyArray<"hinted" | "revealed">): "none" | "hinted" | "revealed" {
  if (exposures.includes("revealed")) return "revealed";
  if (exposures.includes("hinted")) return "hinted";
  return "none";
}

function notFound(message: string): never {
  throw Object.assign(new Error(message), { code: "NOT_FOUND" as const });
}

export function createOpeningAttemptService(sql: Sql) {
  const attempts = createOpeningLearningAttemptRepository(sql), learning = createOpeningLearningRepository(sql);
  return {
    create(scope: Scope, raw: unknown) { return attempts.create(scope, learningAttemptCreateInputSchema.parse(raw)); },
    async get(scope: Scope, id: string) {
      const attempt = await attempts.get(scope, uuidSchema.parse(id));
      if (!attempt) notFound("attempt not found");
      const exposures = await learning.listDeliveredExposures(scope, attempt.sessionId);
      return {
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        deliveredAssistance: highestDeliveredAssistance(exposures),
      };
    },
    async submit(scope: Scope, id: string, raw: unknown) {
      const input = learningAttemptSubmitInputSchema.parse(raw);
      const attempt = await attempts.assertAccess(scope, uuidSchema.parse(id));
      const exposures = await learning.listDeliveredExposures(scope, attempt.sessionId);
      const assistance = resolveAssistance(input.assistance, exposures);
      return learning.insertObservation(scope, { ...input, assistance, attemptId: attempt.id, sessionId: attempt.sessionId,
        courseId: attempt.courseId, skillLabel: attempt.skillLabel, sourceIds: attempt.sourceIds, problemId: attempt.problemId });
    },
  };
}
