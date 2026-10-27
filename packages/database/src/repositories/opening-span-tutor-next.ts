import type { Scope, SpanLessonSnapshot } from "@aistudy/contracts";
import { nextLearningStep, type NextLearningStep } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { learningError, lockWorkspaceLearningHistory, probeLearningSourcesAvailability } from "./opening-learning-facts";
import { createOpeningSpanSessionRepository } from "./opening-span-session";
import { createOpeningSpanTutorContextRepository } from "./opening-span-tutor-context";
import { readOpeningSpanTutorOrigin, readOpeningSpanTutorOriginChange, type OpeningSpanTutorOriginReference } from "./opening-span-tutor-origin";
import { readSpanTutorAuthorization } from "./opening-span-tutor-grant";

export type OpeningSpanNextInput = OpeningSpanTutorOriginReference & { clientKey: string };
export type OpeningSpanNextChoiceReason = "unknown_evidence" | "source_unavailable" | "authorization_required" | "cancelled" | "expired" | "unseen_unavailable" | "evidence_changed";
export type OpeningSpanNextResult = { kind: "ready"; session: SpanLessonSnapshot; decision: NextLearningStep | null; replayed: boolean }
  | { kind: "choice"; reason: OpeningSpanNextChoiceReason; courseId: string; originSession: SpanLessonSnapshot | null; historicalSession?: SpanLessonSnapshot };
function transactionClient(tx: TransactionSql): Sql {
  return new Proxy(tx, { get(target, key, receiver) {
    if (key === "begin") return (...args: unknown[]) => target.savepoint(nested =>
      (args.at(-1) as (value: TransactionSql) => Promise<unknown>)(nested));
    return Reflect.get(target, key, receiver);
  } }) as unknown as Sql;
}
/** Explicit continuation closes only its own origin. The old retest/task remains historical fact. */
export function createOpeningSpanTutorNextRepository(sql: Sql) {
  return { async next(scope: Scope, input: OpeningSpanNextInput): Promise<OpeningSpanNextResult> {
    return sql.begin(async tx => {
      await lockWorkspaceLearningHistory(tx, scope);
      const db = transactionClient(tx), sessions = createOpeningSpanSessionRepository(db);
      const reference: OpeningSpanTutorOriginReference = { activityId: input.activityId, expectedRevision: input.expectedRevision, observationId: input.observationId };
      // This semantic identity survives a refresh and an unknown HTTP response.
      const operationId = `span-next:${input.activityId}:${input.observationId ?? "none"}`;
      const [receipt] = await tx`SELECT id,goal_json FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND client_key=${`span-lesson:${operationId}`} FOR SHARE`;
      if (receipt) {
        const prior = (receipt.goal_json as { tutorNextAction?: { originReference?: Partial<OpeningSpanTutorOriginReference> } } | null)?.tutorNextAction?.originReference;
        if (prior?.activityId !== reference.activityId || prior.observationId !== reference.observationId) throw learningError("CONFLICT", "原后续活动回执与这次请求不一致，请重新核对。");
        const session = await sessions.get(scope, String(receipt.id));
        if (!session) throw learningError("CONFLICT", "原后续活动回执尚不完整，请保留同一次请求。");
        const changed = await readOpeningSpanTutorOriginChange(db, scope, session.activityId);
        if (changed) return { kind: "choice", reason: changed.reason, courseId: session.courseId, originSession: changed.originSession, historicalSession: session };
        return { kind: "ready", session, decision: null, replayed: true };
      }
      const original = await sessions.get(scope, input.activityId);
      if (!original) throw learningError("NOT_FOUND", "原学习活动不存在。");
      if (original.revision !== input.expectedRevision) throw learningError("CONFLICT", "原学习进度已更新，请重新读取后选择下一步。");
      const changed = await readOpeningSpanTutorOriginChange(db, scope, original.activityId);
      if (changed) return { kind: "choice", reason: changed.reason, courseId: original.courseId, originSession: changed.originSession, historicalSession: original };
      const choice = (reason: OpeningSpanNextChoiceReason): OpeningSpanNextResult => ({ kind: "choice", reason, courseId: original.courseId, originSession: original });
      const materials = await probeLearningSourcesAvailability(tx, scope, original.sourceIds);
      if (materials.availableIds.length !== original.sourceIds.length) return choice("source_unavailable");
      if (original.retestId) {
        const [retest] = await tx`SELECT status,deadline_at FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND course_id=${original.courseId}
          AND (id=${original.retestId} OR candidate_id=${original.retestId} OR candidate_reference_id=${original.retestId})`;
        if (!retest || ["cancelled", "declined", "invalidated", "superseded"].includes(String(retest.status))) return choice("cancelled");
        if (retest.deadline_at && new Date(retest.deadline_at as string | Date).getTime() < Date.now() && retest.status !== "completed") return choice("expired");
      }
      const { observation } = await readOpeningSpanTutorOrigin(db, scope, reference, original.courseId);
      if (observation && observation.eligibility?.usableForCurrentVersion !== "yes") return choice("source_unavailable");
      if (observation && (observation.serverEvaluation?.evaluatorVersion !== "span-exact-v1"
        || observation.serverEvaluation.decision === "abstain" || observation.eligibility?.verifiedCorrect === "unknown")) return choice("unknown_evidence");
      const authorization = await readSpanTutorAuthorization(tx, scope, original.courseId);
      if (!authorization.authorized) return choice("authorization_required");
      const repository = createOpeningSpanTutorContextRepository(db);
      const context = await repository.read(scope, { courseId: original.courseId, sourceIds: [], sourceVersions: {}, question: "继续学习", originReference: reference });
      if (!context) return choice("authorization_required");
      if (context.unseenUnavailableReason) return choice("unseen_unavailable");
      const decision = nextLearningStep(context.decisionInput);
      try {
        const session = await repository.execute(scope, { context, decision, operationId });
        return { kind: "ready", session, decision, replayed: false };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "SPAN_UNSEEN_UNAVAILABLE") return choice("unseen_unavailable");
        throw error;
      }
    }) as Promise<OpeningSpanNextResult>;
  } };
}
