import type { ActionCandidate, PlanDraft, Scope } from "@aistudy/contracts";
import type { OpeningActionService } from "./action-service";
import type { OpeningPlanService } from "./plan-service";

/**
 * T03 / P02 adapters for P04 source revision.
 * Existing candidate accept/reject and plan accept/reject routes keep their
 * confirmation semantics — these helpers are additive call sites only.
 */

/** Mark prior pending rows superseded when a corrected source candidate arrives. */
export function adaptCandidateSourceRevision(
  actionService: OpeningActionService,
  scope: Scope,
  revised: ActionCandidate,
) {
  return actionService.reviseSourceCandidate(scope, revised);
}

/**
 * After an accepted schedule is corrected, propose only the delta task ids.
 * Uses action-service filtering + P02 proposeDeltaPlan; never silent full re-accept.
 */
export async function adaptPlanDeltaAfterAcceptedRevision(
  planService: Pick<OpeningPlanService, "proposeDeltaPlan">,
  input: {
    scope: Scope;
    date: string;
    previouslyAcceptedTaskIds: readonly string[];
    revisedCandidateTaskIds: readonly string[];
    clientKey: string;
  },
): Promise<PlanDraft | null> {
  const prior = new Set(input.previouslyAcceptedTaskIds);
  const taskIds = input.revisedCandidateTaskIds.filter((id) => !prior.has(id));
  if (taskIds.length === 0) return null;
  return planService.proposeDeltaPlan(input.scope, {
    date: input.date,
    taskIds,
    clientKey: input.clientKey,
  });
}
