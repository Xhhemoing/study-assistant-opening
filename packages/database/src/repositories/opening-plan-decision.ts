import type { PlanDraft, Scope } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { readOpeningLearnerState } from "./opening-learner-state-read";
import { recordOpeningLearningDecision } from "./opening-learning-decisions";
import { readProjectedOpeningAdaptivePrefs } from "./opening-learning-goal-bridge";

/** A receipt belongs to a newly generated draft. Existing drafts never gain invented historical reasons. */
export async function recordOpeningPlanDraftDecision(tx: TransactionSql, scope: Scope, draft: PlanDraft, unscheduledReasons: Array<{ taskId: string; reason: string }> = []) {
  const state = await readOpeningLearnerState(tx, scope);
  const prefs = await readProjectedOpeningAdaptivePrefs(tx, scope);
  const selected = new Set(draft.blocks.map(block => block.taskId));
  const refFor = (id: string) => { const suggestion = draft.suggestedTasks?.find(row => row.id === id); return suggestion ? `suggestion:${suggestion.key}` : `task:${id}`; };
  const candidates = [
    ...draft.blocks.map(block => ({ action: `schedule:${block.taskId}`, eligible: true,
      reasonCodes: [draft.reasons?.[block.taskId]?.code ?? "pending_task"], evidenceRefs: [refFor(block.taskId)] })),
    ...draft.unscheduledTaskIds.filter(id => !selected.has(id)).map(id => ({ action: `schedule:${id}`, eligible: false,
      reasonCodes: [unscheduledReasons.find(row => row.taskId === id)?.reason ?? "not_scheduled_in_draft"], evidenceRefs: [refFor(id)] })),
    { action: "propose_plan_draft", eligible: true, reasonCodes: ["learner_confirmation_required"], evidenceRefs: [`plan_draft:${draft.id}`] },
  ];
  return recordOpeningLearningDecision(tx, scope, { layer: "plan", targetId: draft.id,
    stateVersion: state.stateVersion, goalVersion: JSON.stringify(prefs),
    intentVersion: `plan-day:${draft.date}:base:${draft.baseVersion}`, policyVersion: draft.strategyVersion ?? "plan-day-v1",
    candidates, selectedAction: "propose_plan_draft", reasonCodes: ["learner_confirmation_required"],
    evidenceRefs: [`plan_draft:${draft.id}`, ...draft.blocks.map(block => refFor(block.taskId))],
    sourceVersions: state.sourceVersions, dataAsOf: state.dataAsOf,
    invalidationConditions: ["state_changed", "goal_changed", "intent_changed", "policy_changed", "source_changed"],
  }, `plan-draft:${draft.id}`);
}
