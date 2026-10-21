import { learningAttemptCreateInputSchema, learningAttemptSubmitInputSchema, learningAttemptContextReadSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import {
  createOpeningKnowledgeRepository,
  createOpeningLearningAttemptRepository,
  createOpeningLearningRepository,
  createOpeningStudyContextRepository,
  createOpeningSpanSessionRepository,
} from "@aistudy/database";
import { assertRetestSubmitEarliestAllowed, prepareRetestSkillLink, resolveAssistance } from "@aistudy/domain";
import type { Sql } from "postgres";

function highestDeliveredAssistance(exposures: ReadonlyArray<"hinted" | "revealed">): "none" | "hinted" | "revealed" {
  if (exposures.includes("revealed")) return "revealed";
  if (exposures.includes("hinted")) return "hinted";
  return "none";
}

function notFound(message: string): never {
  throw Object.assign(new Error(message), { code: "NOT_FOUND" as const });
}

function validation(message: string): never {
  throw Object.assign(new Error(message), { code: "VALIDATION" as const });
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Load retest timing floors for submit earliest check (scoped by workspace owner). */
async function loadRetestSubmitEarliestTimes(sql: Sql, scope: Scope, retestId: string) {
  const rows = await sql`
    SELECT not_before_at, recommended_at, scheduled_start_at
    FROM opening_retest_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND (candidate_id=${retestId} OR id=${retestId} OR candidate_reference_id=${retestId})
  `;
  if (rows.length !== 1) validation("retest activity is missing or ambiguous");
  const row = rows[0] as {
    not_before_at: unknown;
    recommended_at: unknown;
    scheduled_start_at: unknown;
  };
  return {
    notBeforeAt: isoOrNull(row.not_before_at),
    recommendedAt: isoOrNull(row.recommended_at),
    scheduledStartAt: isoOrNull(row.scheduled_start_at),
  };
}

export function createOpeningAttemptService(sql: Sql) {
  const attempts = createOpeningLearningAttemptRepository(sql);
  const learning = createOpeningLearningRepository(sql);
  const knowledge = createOpeningKnowledgeRepository(sql);
  return {
    create(scope: Scope, raw: unknown) { return attempts.create(scope, learningAttemptCreateInputSchema.parse(raw)); },
    async get(scope: Scope, id: string) {
      const attempt = await attempts.get(scope, uuidSchema.parse(id));
      if (!attempt) notFound("attempt not found");
      const exposures = await learning.listDeliveredExposures(scope, attempt.sessionId, { attemptId: attempt.id, assessmentDomain: attempt.requirementKey?.startsWith("language:") ? "language" : "math" });
      return {
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        deliveredAssistance: highestDeliveredAssistance(exposures),
      };
    },
    async getContext(scope: Scope, id: string) {
      const attempt = await attempts.assertAccess(scope, uuidSchema.parse(id));
      const contextAnchor = await createOpeningStudyContextRepository(sql).resolve(scope,
        attempt.contextAnchor ?? { purpose: "learning_help" },
        { attemptId: attempt.id, sessionId: attempt.sessionId, courseId: attempt.courseId, sourceIds: attempt.sourceIds });
      const exposures = await learning.listDeliveredExposures(scope, attempt.sessionId, {
        attemptId: attempt.id, assessmentDomain: attempt.requirementKey?.startsWith("language:") ? "language" : "math",
      });
      const result = learningAttemptContextReadSchema.safeParse({ attempt: { ...attempt, contextAnchor },
        deliveredAssistance: highestDeliveredAssistance(exposures) });
      if (!result.success) validation("本次作答缺少可验证的题目或材料版本，请返回原题重新打开。");
      return result.data;
    },
    async submit(scope: Scope, id: string, raw: unknown) {
      const input = learningAttemptSubmitInputSchema.parse(raw);
      const attempt = await attempts.assertAccess(scope, uuidSchema.parse(id));
      const exposures = await learning.listDeliveredExposures(scope, attempt.sessionId, { attemptId: attempt.id, assessmentDomain: attempt.requirementKey?.startsWith("language:") ? "language" : "math" });
      const [reported] = attempt.spanExercise ? await sql`SELECT id FROM opening_study_intent_events WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND attempt_id=${attempt.id} AND payload->'signals' @> '["copied_answer"]'::jsonb LIMIT 1` : [];
      const assistance = resolveAssistance(reported ? "revealed" : input.assistance, exposures);
      const base = {
        ...input,
        assistance,
        attemptId: attempt.id,
        sessionId: attempt.sessionId,
        courseId: attempt.courseId,
        skillLabel: attempt.skillLabel,
        sourceIds: attempt.sourceIds,
        problemId: attempt.problemId,
      };
      // Span's canonical evaluation and retest binding are checked together in
      // the observation transaction. Keep the learner's original request level
      // separate from help delivered later so an exact retry remains a replay.
      const spanLesson = attempt.spanExercise && attempt.contextAnchor?.activityId
        ? await createOpeningSpanSessionRepository(sql).get(scope, attempt.contextAnchor.activityId) : null;
      if (spanLesson?.sessionId === attempt.sessionId) return learning.insertObservation(scope, base, { submittedAssistance: input.assistance });
      // K02 L02 close: resolve nodeId for independent retest so Data links SkillEvidence in the same tx.
      if (!input.retestId) {
        return learning.insertObservation(scope, base);
      }
      // DL11: server re-checks earliest-allowed before inserting observation (UI disable is not a guarantee).
      const earliestTimes = await loadRetestSubmitEarliestTimes(sql, scope, input.retestId);
      assertRetestSubmitEarliestAllowed(earliestTimes, new Date());
      const current = await knowledge.get(scope, attempt.courseId);
      // V2-13: dimension must be explicit (domain no longer defaults transfer).
      const skillLink = prepareRetestSkillLink({
        retestId: input.retestId,
        assistance,
        outcome: input.outcome,
        skillLabel: attempt.skillLabel,
        dimension: "transfer",
        snapshot: current?.snapshot ?? null,
      });
      return learning.insertObservation(
        scope,
        skillLink ? { ...base, nodeId: skillLink.nodeId, dimension: skillLink.dimension } : base,
      );
    },
  };
}
