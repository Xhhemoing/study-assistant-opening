import { z } from "zod";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningStudyExposureRepository } from "@aistudy/database";
import type { Sql } from "postgres";
const schema = z.object({ attemptId: z.string().uuid() }).strict();
export function createSpanHintService(sql: Sql) {
  return { async read(scope: Scope, raw: unknown) {
    const { attemptId } = schema.parse(raw);
    const attempt = await createOpeningLearningAttemptRepository(sql).assertAccess(scope, attemptId);
    if (attempt.spanExercise?.id !== "span-faded-3d") throw Object.assign(new Error("这道题没有预置的渐隐提示"), { code: "VALIDATION" });
    const exposureReceipt = await createOpeningStudyExposureRepository(sql).deliver(scope, {
      releaseKey: `span-faded-hint:${attempt.id}`, contextAnchor: { attemptId: attempt.id, itemVersionId: attempt.itemVersionId, courseId: attempt.courseId, purpose: "learning_help" },
      sessionId: attempt.sessionId, origin: "assistant", kind: "hint", level: "hinted",
    });
    return { attemptId: attempt.id, text: "渐隐提示：从 αv+βw=u 写出各坐标方程；系数和最后的坐标检查由你完成。本题按含提示练习记录。", exposureReceipt };
  } };
}
