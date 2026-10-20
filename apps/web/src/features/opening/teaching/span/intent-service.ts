import { studyIntentEventInputSchema, type Scope } from "@aistudy/contracts";
import { createOpeningStudyIntentRepository, appendOpeningStudyIntentInTx, readOpeningStudyIntentInTx, readOpeningLearnerState, readOpeningLearningDecisionByClientKey, recordOpeningLearningDecision } from "@aistudy/database";
import { createSpanTeachingSequence, spanModeForIntent } from "@aistudy/domain";
import type { Sql } from "postgres";
/** Explicit user instructions become versioned strategy facts, never correctness verdicts. */
export function createStudyIntentService(sql: Sql) {
  return {
    latest(scope: Scope, sessionId: string) { return createOpeningStudyIntentRepository(sql).latest(scope, sessionId); },
    forCourse(scope: Scope, eventId: string, courseId: string) { return createOpeningStudyIntentRepository(sql).forCourse(scope, eventId, courseId); },
    async apply(scope: Scope, raw: unknown) {
    const input = studyIntentEventInputSchema.parse(raw);
    return sql.begin(async tx => {
      const event = await appendOpeningStudyIntentInTx(tx, scope, input);
      const current = (await readOpeningStudyIntentInTx(tx, scope, input.sessionId))!;
      const mode = spanModeForIntent(event.intent);
      const teachingSequence = createSpanTeachingSequence(mode);
      const sequence = [...teachingSequence, { ...teachingSequence[teachingSequence.length - 1]!, id: `${mode}-reserved`, presentation: { kind: "independent_item" as const, instructions: "离开先前答案，用服务器新发放的保留题再检查。" } }];
      const move = event.action === "clarify_intent" ? { id: "clarify_intent", presentation: { instructions: "先明确本轮目的：串讲、自学或拔高。" }, studentAction: "选择一个明确目的，当前步骤保持原位。" } : event.action === "diagnose" ? sequence[0]! : event.action === "increase_challenge" ? sequence[0]!
        : (event.signals.includes("guessed") || event.signals.includes("copied_answer"))
          ? sequence[sequence.length - 1]! : sequence[0]!;
      const intentVersion = `${event.id}:v${event.version}`;
      const previous = await readOpeningLearningDecisionByClientKey(tx, scope, `${input.clientKey}:session`);
      if (previous) {
        const activityDecision = await readOpeningLearningDecisionByClientKey(tx, scope, `${input.clientKey}:activity`);
        if (!activityDecision || previous.intentVersion !== intentVersion) throw Object.assign(new Error("意图回执不完整或身份已改变"), { code: "CONFLICT" });
        return { event, currentEvent: current, currentIntent: current.intent, currentVersion: current.version, move, sessionDecision: previous, activityDecision };
      }
      const state = await readOpeningLearnerState(tx, scope);
      const reasons = [event.change.kind === "signal" ? `user_reported_${event.change.signal}` : event.change.kind === "explicit_request" ? "explicit_user_instruction" : "explicit_preference_change", "correctness_unchanged", `teaching_action_${event.action}`];
      const versions = { stateVersion: state.stateVersion, goalVersion: "span-unit-v1", intentVersion, policyVersion: "span-teaching-v2",
        candidates: sequence.map(candidate => ({ action: candidate.id, eligible: event.action !== "clarify_intent", reasonCodes: [event.action === "clarify_intent" ? "intent_ambiguous" : candidate.id === move.id ? "matches_user_instruction" : "other_available_move"], evidenceRefs: input.attemptId ? [input.attemptId] : [] })).concat(event.action === "clarify_intent" ? [{ action: "clarify_intent", eligible: true, reasonCodes: ["intent_ambiguous"], evidenceRefs: [] }] : []),
        selectedAction: move.id, reasonCodes: reasons, evidenceRefs: input.attemptId ? [input.attemptId] : [], sourceVersions: state.sourceVersions,
        dataAsOf: state.dataAsOf, invalidationConditions: ["state_changed", "goal_changed", "intent_changed", "policy_changed", "source_changed"] as const };
      const sessionDecision = await recordOpeningLearningDecision(tx, scope, { ...versions, layer: "session", targetId: event.sessionId, invalidationConditions: [...versions.invalidationConditions] }, `${input.clientKey}:session`);
      const activityDecision = await recordOpeningLearningDecision(tx, scope, { ...versions, layer: "activity", targetId: event.activityId, parentDecisionId: sessionDecision.id, invalidationConditions: [...versions.invalidationConditions] }, `${input.clientKey}:activity`);
      return { event, currentEvent: current, currentIntent: current.intent, currentVersion: current.version, move, sessionDecision, activityDecision };
    });
  } };
}
