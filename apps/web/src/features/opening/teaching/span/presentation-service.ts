import { z } from "zod";
import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningStudyExposureRepository } from "@aistudy/database";
import { getSpanProblem, solveSpanProblem, SPAN_SKILL_LABEL } from "@aistudy/domain";
import type { Sql } from "postgres";
const inputSchema = z.object({ sessionId: z.string().uuid().optional(), courseId: z.string().uuid(), sourceId: z.string().uuid(),
  kind: z.enum(["worked", "simulation", "overview"]), clientKey: z.string().min(8).max(160) }).strict();

/** Demo content and its release share the real item/family identity before any answer is returned. */
export function createSpanPresentationService(sql: Sql) {
  return { async read(scope: Scope, raw: unknown) {
    const input = inputSchema.parse(raw), problemId = input.kind === "worked" ? "span-example-2d" : input.kind === "overview" ? "span-faded-3d" : "span-simulation-dependent";
    const problem = getSpanProblem(problemId);
    if (!problem) throw Object.assign(new Error("示范内容版本暂不可用"), { code: "NOT_FOUND" });
    const attempts = createOpeningLearningAttemptRepository(sql);
    const [existing] = await sql`SELECT id FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
    let attempt = existing ? await attempts.assertAccess(scope, String(existing.id)) : null;
    if (attempt && (attempt.courseId !== input.courseId || (input.sessionId && attempt.sessionId !== input.sessionId) || attempt.spanExercise?.id !== problem.id || !attempt.sourceIds.includes(input.sourceId))) throw Object.assign(new Error("示范请求身份已改变"), { code: "CONFLICT" });
    if (!attempt) {
      let sessionId = input.sessionId;
      const learning = createOpeningLearningRepository(sql);
      if (sessionId) {
        const session = await learning.getSession(scope, sessionId);
        if (!session || session.courseId !== input.courseId || !session.sourceIds.includes(input.sourceId)) throw Object.assign(new Error("示范会话或课程材料不匹配"), { code: "NOT_FOUND" });
      } else sessionId = (await learning.createSession(scope, { courseId: input.courseId, sourceIds: [input.sourceId], skillLabel: SPAN_SKILL_LABEL })).id;
      attempt = await attempts.create(scope, { sessionId, clientKey: input.clientKey, spanExercise: { sourceId: input.sourceId, problemId: problem.id, version: Number(problem.version) } });
    }
    const exposureReceipt = await createOpeningStudyExposureRepository(sql).deliver(scope, { releaseKey: `${input.clientKey}:release`,
      contextAnchor: { courseId: attempt.courseId, attemptId: attempt.id, itemVersionId: attempt.itemVersionId, purpose: "learning_help" },
      sessionId: attempt.sessionId, origin: "assistant", kind: "solution", level: "revealed" });
    return { problem: attempt.spanExercise!, solution: solveSpanProblem(attempt.spanExercise!), exposureReceipt };
  } };
}
