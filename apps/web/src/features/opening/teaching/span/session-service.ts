import { z } from "zod";
import { studySessionIntentSchema, type Scope, type StudySessionIntent } from "@aistudy/contracts";
import { readOpeningStudyIntentInTx, appendOpeningStudyIntentInTx, lockWorkspaceLearningHistory, readOpeningLearnerState, readOpeningLearningDecisionByClientKey, recordOpeningLearningDecision } from "@aistudy/database";
import { assertRetestSubmitEarliestAllowed, SPAN_REQUIREMENT_KEY, createSpanTeachingSequence, spanModeForIntent } from "@aistudy/domain";
import type { Sql } from "postgres";

export const spanSessionIntentSchema = studySessionIntentSchema;
const inputSchema = z.object({ sessionId: z.string().uuid(), intent: spanSessionIntentSchema,
  clientKey: z.string().min(8).max(160), moveId: z.string().min(1).max(100), retestId: z.string().uuid().optional() }).strict();

export function spanSessionProblemIds(intent: StudySessionIntent): string[] {
  const mode = spanModeForIntent(intent);
  return mode === "challenge" ? ["span-contrast-dependent", "span-geometry-transfer"]
    : mode === "overview" ? ["span-faded-3d", "span-contrast-dependent", "span-geometry-transfer"]
      : ["span-faded-3d", "span-independent-3d"];
}

/** Persist the intent and both decision layers beside the actual learning session. */
export function createSpanSessionService(sql: Sql) {
  return {
    async prepare(scope: Scope, raw: unknown) {
      const input = inputSchema.parse(raw);
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        const [session] = await tx`SELECT id,activity_id,course_id FROM opening_learning_sessions WHERE id=${input.sessionId}
          AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        if (!session) throw Object.assign(new Error("学习会话不存在"), { code: "NOT_FOUND" });
        if (input.retestId) {
          const retests = await tx`SELECT not_before_at,recommended_at,scheduled_start_at FROM opening_retest_activities
            WHERE (id=${input.retestId} OR candidate_id=${input.retestId} OR candidate_reference_id=${input.retestId}) AND workspace_id=${scope.workspaceId}
              AND owner_user_id=${scope.ownerUserId} AND course_id=${String(session.course_id)} AND requirement_key=${SPAN_REQUIREMENT_KEY}
              AND status IN ('accepted','in_progress') FOR SHARE`;
          if (retests.length !== 1) throw Object.assign(new Error("延迟复测不属于本课程、尚未接受或身份不唯一"), { code: "VALIDATION" });
          const retest = retests[0]!;
          const iso = (value: unknown) => value == null ? null : new Date(value as Date).toISOString();
          assertRetestSubmitEarliestAllowed({ notBeforeAt: iso(retest.not_before_at), recommendedAt: iso(retest.recommended_at), scheduledStartAt: iso(retest.scheduled_start_at) }, new Date());
        }
        const priorDecision = await readOpeningLearningDecisionByClientKey(tx, scope, `${input.clientKey}:session`);
        if (priorDecision?.intentVersion === JSON.stringify(input.intent)) {
          const activityDecision = await readOpeningLearningDecisionByClientKey(tx, scope, `${input.clientKey}:activity`);
          if (!activityDecision || priorDecision.targetId !== input.sessionId || activityDecision.selectedAction !== input.moveId) throw Object.assign(new Error("旧学习请求身份或动作已改变"), { code: "CONFLICT" });
          const current = await readOpeningStudyIntentInTx(tx, scope, input.sessionId);
          return { sessionDecision: priorDecision, activityDecision, currentIntent: current?.intent ?? input.intent,
            moves: createSpanTeachingSequence(spanModeForIntent(input.intent)), problemIds: spanSessionProblemIds(input.intent), replayed: true, legacyReceipt: true };
        }
        const intentEvent = await appendOpeningStudyIntentInTx(tx, scope, { sessionId: input.sessionId, clientKey: `${input.clientKey}:intent`, change: { kind: "preference", intent: input.intent } });
        const intentVersion = `${intentEvent.id}:v${intentEvent.version}`;
        const moves = createSpanTeachingSequence(spanModeForIntent(input.intent));
        const selectedMove = moves.find(move => move.id === input.moveId);
        if (!selectedMove) throw Object.assign(new Error("教学动作不属于本次学习目的"), { code: "VALIDATION" });
        const existing = priorDecision;
        if (existing) {
          const activityDecision = await readOpeningLearningDecisionByClientKey(tx, scope, `${input.clientKey}:activity`);
          if (!activityDecision || activityDecision.selectedAction !== selectedMove.id) throw Object.assign(new Error("教学动作请求已改变"), { code: "CONFLICT" });
          if (existing.targetId !== input.sessionId || existing.intentVersion !== intentVersion) throw Object.assign(new Error("学习请求身份或意图已改变"), { code: "CONFLICT" });
          return { sessionDecision: existing, activityDecision, moves, problemIds: spanSessionProblemIds(input.intent), replayed: true };
        }
        const state = await readOpeningLearnerState(tx, scope);
        const reasons = ["explicit_session_intent", input.intent.selfReportedFatigue === "high" ? "fatigue_short_steps" : "new_item_after_support"];
        const candidates = ["self_study", "overview", "challenge"].map(mode => ({ action: createSpanTeachingSequence(mode as "self_study" | "overview" | "challenge")[0]!.id,
          eligible: mode === spanModeForIntent(input.intent), reasonCodes: mode === spanModeForIntent(input.intent) ? reasons : ["different_user_purpose"], evidenceRefs: [] }));
        const captured = { stateVersion: state.stateVersion, goalVersion: "span-unit-v1", intentVersion,
          policyVersion: "span-teaching-v2", candidates, selectedAction: moves[0]!.id, reasonCodes: reasons, evidenceRefs: [],
          sourceVersions: state.sourceVersions, dataAsOf: state.dataAsOf,
          invalidationConditions: ["state_changed", "goal_changed", "intent_changed", "policy_changed", "source_changed"] as const };
        const sessionDecision = await recordOpeningLearningDecision(tx, scope, { ...captured, layer: "session", targetId: input.sessionId,
          invalidationConditions: [...captured.invalidationConditions] }, `${input.clientKey}:session`);
        // Session creation already owns this activity; the write preserves all other goal fields.
        const rows = await tx`UPDATE opening_teaching_activities a SET goal_json=COALESCE(a.goal_json,'{}'::jsonb) || ${tx.json({ sessionIntent: input.intent })}::jsonb
          FROM opening_learning_sessions s WHERE s.id=${input.sessionId} AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
            AND a.id=s.activity_id AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id RETURNING a.id`;
        if (!rows[0]) throw Object.assign(new Error("学习活动不存在"), { code: "NOT_FOUND" });
        const activityDecision = await recordOpeningLearningDecision(tx, scope, { ...captured, selectedAction: selectedMove.id, candidates: moves.map(move => ({ action: move.id, eligible: true, reasonCodes: [move.id === selectedMove.id ? "selected_learning_step" : "other_unit_step"], evidenceRefs: [] })), reasonCodes: ["user_selected_learning_step", "new_answer_before_feedback"], layer: "activity", targetId: String(rows[0].id), parentDecisionId: sessionDecision.id,
          invalidationConditions: [...captured.invalidationConditions] }, `${input.clientKey}:activity`);
        return { sessionDecision, activityDecision, moves, problemIds: spanSessionProblemIds(input.intent), replayed: false };
      });
    },
  };
}
