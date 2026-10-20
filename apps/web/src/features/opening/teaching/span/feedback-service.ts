import { z } from "zod";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningStudyExposureRepository } from "@aistudy/database";
import { verifySpanAnswer } from "@aistudy/domain";
import type { Sql } from "postgres";
const inputSchema = z.object({ attemptId: z.string().uuid() }).strict();
/** A solution is released only after the immutable original attempt was submitted. */
export function createSpanFeedbackService(sql: Sql) {
  return { async read(scope: Scope, raw: unknown) {
    const input = inputSchema.parse(raw);
    const attempt = await createOpeningLearningAttemptRepository(sql).assertAccess(scope, input.attemptId);
    if (!attempt.spanExercise || !attempt.submittedAt || !attempt.observationId) throw Object.assign(new Error("先保存自己的首答，再查看本题解法。"), { code: "VALIDATION" });
    const [original] = await sql`SELECT answer FROM opening_learning_observations WHERE id=${attempt.observationId}
      AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND attempt_id=${attempt.id}`;
    if (!original) throw Object.assign(new Error("原始首答暂不可读取"), { code: "NOT_FOUND" });
    const result = verifySpanAnswer(attempt.spanExercise, String(original.answer));
    const exposureReceipt = await createOpeningStudyExposureRepository(sql).deliver(scope, {
      releaseKey: `span-feedback:${attempt.id}`, contextAnchor: { attemptId: attempt.id, itemVersionId: attempt.itemVersionId,
        courseId: attempt.courseId, purpose: "history_solution" }, sessionId: attempt.sessionId,
      origin: "history_solution", kind: "solution", level: "revealed",
    });
    return { attemptId: attempt.id, result, exposureReceipt };
  } };
}
