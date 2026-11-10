import { spanRepairIssueInputSchema, type Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptInTx, lockWorkspaceLearningHistory, readOpeningSpanReservedChoice,
  readOpeningSpanRepair, readOpeningSpanCourseBinding, spanRepairAttemptKey, createOpeningSpanSessionRepository, readOpeningSpanRepairVariant, openingSpanRepairRetryKey } from "@aistudy/database";
import { z } from "zod";
import type { Sql } from "postgres";
import { getSpanReservedProblem, getSpanTeachingProblem } from "@aistudy/domain/span-heldout-catalog";
const inputSchema = z.object({ sessionId: z.string().uuid(), sourceId: z.string().uuid(), clientKey: z.string().min(8).max(160), mode: z.enum(["self_study", "overview", "challenge"]), afterAttemptId: z.string().uuid().optional() }).strict();

/** Reserved operands are issued here only. No solution enters a browser bundle or response. */
export function createSpanReservedService(sql: Sql) {
  return { async issue(scope: Scope, raw: unknown) {
    if (raw && typeof raw === "object" && "repairVersion" in raw) {
      const input = spanRepairIssueInputSchema.parse(raw);
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const plan = await readOpeningSpanRepair(tx, scope, input.activityId);
        const session = await createOpeningSpanSessionRepository(tx as unknown as Sql).get(scope, input.activityId);
        const expectedMove = input.stage === "variant" ? "self-faded" : "self_study-reserved";
        if (!session || session.status !== "active" || session.revision !== input.expectedRevision || session.moveId !== expectedMove || plan?.status !== "ready") {
          throw Object.assign(new Error("本题步骤或版本已变化，请重新读取；未提前发放确认题。"), { code: "CONFLICT" });
        }
        const currentVariant = input.stage === "variant" ? await readOpeningSpanRepairVariant(tx, scope, input.activityId) : null;
        const clientKey = input.retryAfterAttemptId
          ? await openingSpanRepairRetryKey(tx, scope, input.activityId, input.retryAfterAttemptId)
          : currentVariant ? String(currentVariant.client_key) : spanRepairAttemptKey(input.activityId, input.stage);
        const [existing] = await tx`SELECT create_intent FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}`;
        const original = (existing?.create_intent as { spanExercise?: { sourceId: string; problemId: string; version: number } } | undefined)?.spanExercise;
        if (original) return createOpeningLearningAttemptInTx(tx, scope, { sessionId: session.sessionId, clientKey, spanExercise: original });
        let identity = plan.practiceVariant;
        if (input.stage === "confirmation") {
          const example = getSpanTeachingProblem(plan.teachingExample.problemId, plan.teachingExample.version)!;
          const choice = await readOpeningSpanReservedChoice(tx, scope, "self_study", "validation", example.familyId);
          if (choice.kind !== "available") throw Object.assign(new Error(choice.reason === "unknown_history"
            ? "曝光历史身份不可核实，新题确认暂不可用。" : "同族新题已耗尽，未借用研究题或复测题。"), { code: "CONFLICT", reasonCode: choice.reason });
          identity = { problemId: choice.problem.id, version: choice.problem.version };
        }
        return createOpeningLearningAttemptInTx(tx, scope, { sessionId: session.sessionId, clientKey,
          spanExercise: { sourceId: session.sourceIds[0]!, problemId: identity.problemId, version: Number(identity.version) } },
        input.retryAfterAttemptId ? { spanRepairRetryParentId: input.retryAfterAttemptId } : undefined);
      });
    }
    const input = inputSchema.parse(raw);
    return sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      const [session] = await tx`SELECT id,course_id,source_ids,activity_id FROM opening_learning_sessions WHERE id=${input.sessionId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
      if (!session || !(session.source_ids as string[]).includes(input.sourceId)) throw Object.assign(new Error("学习会话或材料不匹配"), { code: "NOT_FOUND" });
      const [activity] = await tx`SELECT checkpoint_json,goal_json FROM opening_teaching_activities WHERE id=${String(session.activity_id)}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
      const lesson = (activity?.checkpoint_json as { spanLesson?: { retestId?: string | null; intent?: { purpose?: string } } } | undefined)?.spanLesson;
      const retestId = lesson?.retestId;
      const courseSpan = await readOpeningSpanCourseBinding(tx, scope, String(session.activity_id));
      if (courseSpan) {
        const current = await createOpeningSpanSessionRepository(tx as unknown as Sql).get(scope, String(session.activity_id));
        if (!current || current.status !== "active" || current.moveId !== "self_study-reserved" || input.mode !== "self_study"
          || retestId || input.afterAttemptId) throw Object.assign(new Error("课程 span 发题只接受原目的的当前检查阶段。"), { code: "CONFLICT" });
      }
      if (await readOpeningSpanRepair(tx, scope, String(session.activity_id))) throw Object.assign(new Error("本活动只接受已绑定版本和阶段的本题步骤发题请求。"), { code: "CONFLICT" });
      let familyId: string | undefined;
      // A learner-requested same-family practice is anchored to a real corrected attempt,
      // never a client-selected family or a way around tutor/retest admission.
      if (input.afterAttemptId) {
        if (retestId || lesson?.intent?.purpose !== "self_study" || (activity?.goal_json as { tutorNextAction?: unknown } | undefined)?.tutorNextAction !== undefined) throw Object.assign(new Error("本入口只用于普通自学改题后的练习"), { code: "CONFLICT" });
        const [origin] = await tx`SELECT a.create_intent,v.evaluation_spec FROM opening_learning_attempts a
          JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
          JOIN opening_learning_observations o ON o.id=a.observation_id AND o.attempt_id=a.id AND o.workspace_id=a.workspace_id AND o.owner_user_id=a.owner_user_id
          WHERE a.id=${input.afterAttemptId} AND a.session_id=${input.sessionId} AND a.course_id=${String(session.course_id)}
            AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
            AND o.server_evaluation->>'decision'='correct' AND o.revision_kind<>'retract'
            AND COALESCE(o.effective_head_id,o.id)=o.id
            AND EXISTS (SELECT 1 FROM opening_learning_attempts prior JOIN opening_learning_observations wrong ON wrong.id=prior.observation_id
              WHERE prior.session_id=a.session_id AND prior.workspace_id=a.workspace_id AND prior.owner_user_id=a.owner_user_id
                AND prior.item_version_id=a.item_version_id AND prior.history_revision<a.history_revision
                AND wrong.server_evaluation->>'decision'='incorrect')`;
        const spec = origin?.evaluation_spec as { problemId?: string; version?: number } | undefined;
        const source = (origin?.create_intent as { spanExercise?: { sourceId?: string } } | undefined)?.spanExercise?.sourceId;
        const problem = spec?.problemId ? getSpanTeachingProblem(spec.problemId, spec.version) ?? getSpanReservedProblem(spec.problemId, spec.version) : null;
        if (!problem || source !== input.sourceId) throw Object.assign(new Error("请先提交并核验原题的订正答案"), { code: "CONFLICT" });
        familyId = problem.familyId;
      }
      const clientKey = input.afterAttemptId ? `span-variant:${input.afterAttemptId}` : input.clientKey;
      const [replay] = await tx`SELECT id,create_intent FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND client_key=${clientKey}`;
      if (replay) {
        const saved = replay.create_intent as { sessionId: string; spanExercise?: { sourceId: string; problemId: string; version: number } };
        if (saved.sessionId !== input.sessionId || saved.spanExercise?.sourceId !== input.sourceId || !getSpanReservedProblem(saved.spanExercise.problemId, saved.spanExercise.version)) throw Object.assign(new Error("保留题请求已改变"), { code: "CONFLICT" });
        return createOpeningLearningAttemptInTx(tx, scope, { sessionId: input.sessionId, clientKey, spanExercise: saved.spanExercise });
      }
      const choice = await readOpeningSpanReservedChoice(tx, scope, input.mode, retestId ? "retest" : "validation", familyId, courseSpan?.allowedExerciseKeys);
      if (choice.kind === "unavailable") throw Object.assign(new Error(choice.reason === "unknown_history"
        ? "旧记录中的题目身份暂不可核实，不能把下一题称作未曝光检查。请先核对旧记录，或继续普通练习。"
        : "本组检查题或题族已发放完毕；可回看记录或继续普通练习，重复不标作未曝光检查。"), { code: "CONFLICT" });
      const candidate = choice.problem;
      return createOpeningLearningAttemptInTx(tx, scope, { sessionId: input.sessionId, clientKey,
        spanExercise: { sourceId: input.sourceId, problemId: candidate.id, version: Number(candidate.version) } });
    });
  } };
}
