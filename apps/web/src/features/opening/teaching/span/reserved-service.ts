import type { Scope } from "@aistudy/contracts";
import { createOpeningLearningAttemptInTx, lockWorkspaceLearningHistory, readOpeningSpanExposureHistory } from "@aistudy/database";
import { listSpanReservedProblems } from "@aistudy/domain/span-heldout-catalog";
import { z } from "zod";
import type { Sql } from "postgres";
const inputSchema = z.object({ sessionId: z.string().uuid(), sourceId: z.string().uuid(), clientKey: z.string().min(8).max(160), mode: z.enum(["self_study", "overview", "challenge"]) }).strict();

/** Reserved operands are issued here only. No solution enters a browser bundle or response. */
export function createSpanReservedService(sql: Sql) {
  return { async issue(scope: Scope, raw: unknown) {
    const input = inputSchema.parse(raw);
    return sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      const [session] = await tx`SELECT id,course_id,source_ids FROM opening_learning_sessions WHERE id=${input.sessionId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
      if (!session || !(session.source_ids as string[]).includes(input.sourceId)) throw Object.assign(new Error("学习会话或材料不匹配"), { code: "NOT_FOUND" });
      const [replay] = await tx`SELECT id,create_intent FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND client_key=${input.clientKey}`;
      if (replay) {
        const saved = replay.create_intent as { sessionId: string; spanExercise?: { sourceId: string; problemId: string; version: number } };
        if (saved.sessionId !== input.sessionId || saved.spanExercise?.sourceId !== input.sourceId || !saved.spanExercise.problemId.startsWith("span-reserved-")) throw Object.assign(new Error("保留题请求已改变"), { code: "CONFLICT" });
        return createOpeningLearningAttemptInTx(tx, scope, { sessionId: input.sessionId, clientKey: input.clientKey, spanExercise: saved.spanExercise });
      }
      const history = await readOpeningSpanExposureHistory(tx, scope);
      if (history.unknownHistory) throw Object.assign(new Error("旧记录中的题目身份暂不可核实，不能把下一题称作未曝光检查。请先核对旧记录，或继续普通练习。"), { code: "CONFLICT" });
      const bank = listSpanReservedProblems();
      const available = bank.filter(problem => !history.problemIds.has(problem.id) && !history.familyIds.has(problem.familyId));
      const desired = input.mode === "challenge" ? "span-reserved-transfer" : input.mode === "overview" ? "span-reserved-dependent" : "span-reserved-fraction";
      const candidate = available.find(problem => problem.id === desired) ?? available[0];
      if (!candidate) throw Object.assign(new Error("本组检查题或题族已发放完毕；可回看记录或继续普通练习，重复不标作未曝光检查。"), { code: "CONFLICT" });
      return createOpeningLearningAttemptInTx(tx, scope, { sessionId: input.sessionId, clientKey: input.clientKey,
        spanExercise: { sourceId: input.sourceId, problemId: candidate.id, version: Number(candidate.version) } });
    });
  } };
}
