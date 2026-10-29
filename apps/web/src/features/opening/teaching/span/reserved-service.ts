import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptInTx, lockWorkspaceLearningHistory, readOpeningSpanReservedChoice } from "@aistudy/database";
import { z } from "zod";
import type { Sql } from "postgres";
import { getSpanReservedProblem } from "@aistudy/domain/span-heldout-catalog";
const inputSchema = z.object({ sessionId: z.string().uuid(), sourceId: z.string().uuid(), clientKey: z.string().min(8).max(160), mode: z.enum(["self_study", "overview", "challenge"]) }).strict();

/** Reserved operands are issued here only. No solution enters a browser bundle or response. */
export function createSpanReservedService(sql: Sql) {
  return { async issue(scope: Scope, raw: unknown) {
    const input = inputSchema.parse(raw);
    return sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      const [session] = await tx`SELECT id,course_id,source_ids,activity_id FROM opening_learning_sessions WHERE id=${input.sessionId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
      if (!session || !(session.source_ids as string[]).includes(input.sourceId)) throw Object.assign(new Error("学习会话或材料不匹配"), { code: "NOT_FOUND" });
      const [replay] = await tx`SELECT id,create_intent FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
      if (replay) {
        const saved = replay.create_intent as { sessionId: string; spanExercise?: { sourceId: string; problemId: string; version: number } };
        if (saved.sessionId !== input.sessionId || saved.spanExercise?.sourceId !== input.sourceId || !getSpanReservedProblem(saved.spanExercise.problemId, saved.spanExercise.version)) throw Object.assign(new Error("保留题请求已改变"), { code: "CONFLICT" });
        return createOpeningLearningAttemptInTx(tx, scope, { sessionId: input.sessionId, clientKey: input.clientKey, spanExercise: saved.spanExercise });
      }
      const [activity] = await tx`SELECT checkpoint_json FROM opening_teaching_activities WHERE id=${String(session.activity_id)}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
      const retestId = (activity?.checkpoint_json as { spanLesson?: { retestId?: string | null } } | undefined)?.spanLesson?.retestId;
      const choice = await readOpeningSpanReservedChoice(tx, scope, input.mode, retestId ? "retest" : "validation");
      if (choice.kind === "unavailable") throw Object.assign(new Error(choice.reason === "unknown_history"
        ? "旧记录中的题目身份暂不可核实，不能把下一题称作未曝光检查。请先核对旧记录，或继续普通练习。"
        : "本组检查题或题族已发放完毕；可回看记录或继续普通练习，重复不标作未曝光检查。"), { code: "CONFLICT" });
      const candidate = choice.problem;
      return createOpeningLearningAttemptInTx(tx, scope, { sessionId: input.sessionId, clientKey: input.clientKey,
        spanExercise: { sourceId: input.sourceId, problemId: candidate.id, version: Number(candidate.version) } });
    });
  } };
}
