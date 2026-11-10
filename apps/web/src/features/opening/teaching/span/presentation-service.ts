import { z } from "zod";
import { spanRepairPresentationInputSchema, type Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptRepository, createOpeningLearningRepository, createOpeningStudyExposureRepository,
  createOpeningLearningAttemptInTx, lockWorkspaceLearningHistory, readOpeningSpanRepair, readOpeningSpanCourseBinding, spanRepairAttemptKey,
  createOpeningSpanSessionRepository, generateOpeningStudyExposure, releaseOpeningStudyExposure } from "@aistudy/database";
import { buildSpanTargetedExplanation, getSpanProblem, solveSpanProblem, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { getSpanTeachingProblem } from "@aistudy/domain/span-heldout-catalog";
import type { Sql } from "postgres";
const inputSchema = z.object({ sessionId: z.string().uuid().optional(), courseId: z.string().uuid(), sourceId: z.string().uuid(),
  kind: z.enum(["worked", "simulation", "overview"]), clientKey: z.string().min(8).max(160) }).strict();

/** Demo content and its release share the real item/family identity before any answer is returned. */
export function createSpanPresentationService(sql: Sql) {
  return { async read(scope: Scope, raw: unknown) {
    if (raw && typeof raw === "object" && "repairVersion" in raw) {
      const input = spanRepairPresentationInputSchema.parse(raw);
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const plan = await readOpeningSpanRepair(tx, scope, input.activityId);
        const session = await createOpeningSpanSessionRepository(tx as unknown as Sql).get(scope, input.activityId);
        if (!session || session.status !== "active" || session.moveId !== "self-example" || plan?.status !== "ready") {
          throw Object.assign(new Error("本题步骤短讲尚不可用或已离开例题阶段；原进度保留。"), { code: "CONFLICT" });
        }
        const clientKey = spanRepairAttemptKey(input.activityId, "example");
        const attempt = await createOpeningLearningAttemptInTx(tx, scope, { sessionId: session.sessionId, clientKey,
          spanExercise: { sourceId: session.sourceIds[0]!, problemId: plan.teachingExample.problemId, version: Number(plan.teachingExample.version) } });
        const targetedExplanation = buildSpanTargetedExplanation(attempt.spanExercise!, plan.targetSkill);
        if (!targetedExplanation) throw Object.assign(new Error("本题步骤的精确例题暂不可用，未返回伪解法。"), { code: "CONFLICT" });
        const generated = await generateOpeningStudyExposure(tx, scope, { releaseKey: `${clientKey}:release`,
          contextAnchor: { courseId: session.courseId, attemptId: attempt.id, itemVersionId: attempt.itemVersionId, purpose: "learning_help" },
          sessionId: session.sessionId, origin: "assistant", kind: "solution", level: "revealed" });
        const exposureReceipt = await releaseOpeningStudyExposure(tx, scope, generated.id);
        return { problem: attempt.spanExercise!, solution: solveSpanProblem(attempt.spanExercise!), exposureReceipt, targetedExplanation };
      });
    }
    const input = inputSchema.parse(raw), problemId = input.kind === "worked" ? "span-example-2d" : input.kind === "overview" ? "span-faded-3d" : "span-simulation-dependent";
    if (input.sessionId) {
      const [owned] = await sql`SELECT activity_id FROM opening_learning_sessions WHERE id=${input.sessionId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if (owned?.activity_id && await readOpeningSpanCourseBinding(sql, scope, String(owned.activity_id))) {
        if (input.kind !== "worked") throw Object.assign(new Error("课程 span 仅使用已确认范围内的示范。"), { code: "CONFLICT" });
        return sql.begin(async tx => {
          await lockWorkspaceLearningHistory(tx, scope);
          const current = await readOpeningSpanCourseBinding(tx, scope, String(owned.activity_id));
          const session = await createOpeningSpanSessionRepository(tx as unknown as Sql).get(scope, String(owned.activity_id));
          if (!current || !session || session.status !== "active" || session.courseId !== input.courseId
            || session.moveId !== "self-example" || !session.sourceIds.includes(input.sourceId))
            throw Object.assign(new Error("课程 span 示范步骤或身份已变化。"), { code: "CONFLICT" });
          // Existing repository savepoints retain this history transaction through release.
          const db = new Proxy(tx, { get(target, key, receiver) {
            if (key === "begin") return (callback: (nested: typeof tx) => Promise<unknown>) => target.savepoint(callback);
            return Reflect.get(target, key, receiver);
          } }) as unknown as Sql;
          const attempt = await createOpeningLearningAttemptRepository(db).createSpanWorked(scope,
            { sessionId: session.sessionId, sourceId: input.sourceId, clientKey: input.clientKey });
          const generated = await generateOpeningStudyExposure(tx, scope, { releaseKey: `${input.clientKey}:release`,
            contextAnchor: { courseId: session.courseId, attemptId: attempt.id, itemVersionId: attempt.itemVersionId, purpose: "learning_help" },
            sessionId: session.sessionId, origin: "assistant", kind: "solution", level: "revealed" });
          const exposureReceipt = await releaseOpeningStudyExposure(tx, scope, generated.id);
          return { problem: attempt.spanExercise!, solution: solveSpanProblem(attempt.spanExercise!), exposureReceipt };
        });
      }
      if (owned?.activity_id && await readOpeningSpanRepair(sql, scope, String(owned.activity_id))) {
        throw Object.assign(new Error("本活动只接受已绑定版本的本题步骤短讲请求，未返回通用讲解。"), { code: "CONFLICT" });
      }
    }
    const attempts = createOpeningLearningAttemptRepository(sql);
    const [existing] = await sql`SELECT id,create_intent FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}
      AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
    let attempt = existing ? await attempts.assertAccess(scope, String(existing.id)) : null;
    const originalSourceId = (existing?.create_intent as { spanExercise?: { sourceId?: string } } | undefined)?.spanExercise?.sourceId;
    const matchesKind = (id: string | undefined, version: string | undefined) => id === problemId || input.kind === "worked"
      && id?.startsWith("span-reserved-generated-teaching-independent-2d-") && Boolean(getSpanTeachingProblem(id, version));
    if (attempt && (attempt.courseId !== input.courseId || (input.sessionId && attempt.sessionId !== input.sessionId) || !matchesKind(attempt.spanExercise?.id, attempt.spanExercise?.version) || originalSourceId !== input.sourceId)) throw Object.assign(new Error("示范请求身份已改变"), { code: "CONFLICT" });
    if (!attempt) {
      let sessionId = input.sessionId;
      const learning = createOpeningLearningRepository(sql);
      if (sessionId) {
        const session = await learning.getSession(scope, sessionId);
        if (!session || session.courseId !== input.courseId || !session.sourceIds.includes(input.sourceId)) throw Object.assign(new Error("示范会话或课程材料不匹配"), { code: "NOT_FOUND" });
      } else sessionId = (await learning.createSession(scope, { courseId: input.courseId, sourceIds: [input.sourceId], skillLabel: SPAN_SKILL_LABEL })).id;
      if (input.kind === "worked") attempt = await attempts.createSpanWorked(scope, { sessionId, sourceId: input.sourceId, clientKey: input.clientKey });
      else {
        const problem = getSpanProblem(problemId)!;
        attempt = await attempts.create(scope, { sessionId, clientKey: input.clientKey, spanExercise: { sourceId: input.sourceId, problemId: problem.id, version: Number(problem.version) } });
      }
      if (!matchesKind(attempt.spanExercise?.id, attempt.spanExercise?.version)) throw Object.assign(new Error("示范请求身份已改变"), { code: "CONFLICT" });
    }
    const exposureReceipt = await createOpeningStudyExposureRepository(sql).deliver(scope, { releaseKey: `${input.clientKey}:release`,
      contextAnchor: { courseId: attempt.courseId, attemptId: attempt.id, itemVersionId: attempt.itemVersionId, purpose: "learning_help" },
      sessionId: attempt.sessionId, origin: "assistant", kind: "solution", level: "revealed" });
    return { problem: attempt.spanExercise!, solution: solveSpanProblem(attempt.spanExercise!), exposureReceipt };
  } };
}
