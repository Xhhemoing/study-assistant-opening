import type { CourseRequirementProgress, CourseRouteActivityContext, CourseRouteNext, CourseRouteStart, Scope } from "@aistudy/contracts";
import type { CourseRouteStep, LearningDecisionCandidate, LearningDecisionInput } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { readOpeningLearnerState } from "./opening-learner-state-read";

type Input = {
  courseId: string; goal: { id: string; revision: number }; request: CourseRouteStart | CourseRouteNext;
  entry: "start" | "next"; requestedId: string; progress: CourseRequirementProgress[];
  excluded: CourseRequirementProgress[]; initialStep: CourseRouteStep | null; context: CourseRouteActivityContext;
};
/** Capture before activity/compile/budget writes. These are this entry's real inputs,
 * not a new policy's hypothetical alternatives or a later reconstruction. */
export async function captureOpeningCourseRouteDecision(tx: TransactionSql, scope: Scope, input: Input): Promise<Omit<LearningDecisionInput, "targetId">> {
  const state = await readOpeningLearnerState(tx, scope, { courseId: input.courseId });
  const { context, initialStep } = input;
  const requirementRef = (row: CourseRequirementProgress) => `requirement:${row.requirement.id}:v${row.requirement.revision}`;
  const selected = input.progress.find(row => row.requirement.id === context.requirementId)!;
  const reasonCodes = [`entry:course-route-${input.entry}`, `progress:${selected.status}`,
    ...(context.retestId ? ["accepted_retest_transfer_check"] : []),
    ...(context.action === "prerequisite" ? ["weak_explicit_prerequisite"] : []),
    ...(context.action === "return" ? ["verified_prerequisite_return"] : []),
    ...(context.action === "comprehensive" ? ["current_scope_comprehensive_run"] : []),
    ...(initialStep && initialStep.action === context.action ? ["course_requirement_progress_rule"] : [])];
  const evidenceRefs = [`course:${input.courseId}`, `goal:${input.goal.id}:v${input.goal.revision}`, requirementRef(selected),
    ...(context.originActivityId ? [`activity:${context.originActivityId}`] : []),
    ...(context.originObservationId ? [`observation:${context.originObservationId}`] : []),
    ...(context.retestId ? [`retest:${context.retestId}`] : [])];
  const candidates: LearningDecisionCandidate[] = input.progress.map(row => ({
    // Requirement candidates are not fabricated calls to the action selector.
    action: row === selected ? context.action : `requirement:${row.requirement.id}`,
    eligible: row === selected,
    reasonCodes: row === selected ? reasonCodes : [`progress:${row.status}`,
      !row.sourcesAvailable ? "source_unavailable" : context.action === "prerequisite" && row.requirement.id === input.requestedId ? "deferred_for_weak_prerequisite"
        : input.requestedId && row.requirement.id !== input.requestedId ? "explicit_requirement_not_selected"
          : row.status === "verified" ? "already_verified" : "course_order_not_selected"],
    evidenceRefs: [requirementRef(row), ...(row.observationId ? [`observation:${row.observationId}`] : [])],
  }));
  candidates.push(...input.excluded.map(row => ({ action: `requirement:${row.requirement.id}`, eligible: false,
    reasonCodes: ["outside_goal_scope"], evidenceRefs: [requirementRef(row)] })));
  if (initialStep && (initialStep.action !== context.action || initialStep.requirementId !== context.requirementId)) {
    candidates.push({ action: initialStep.action, eligible: false,
      reasonCodes: [context.retestId ? "overridden_by_bound_retest" : context.action === "return" ? "overridden_by_return" : "overridden_by_comprehensive_run"],
      evidenceRefs: [`requirement:${initialStep.requirementId}`, ...(initialStep.focusObservationId ? [`observation:${initialStep.focusObservationId}`] : [])] });
  }
  // LearnerState only includes observed sources; the route also uses unobserved
  // requirement references. Preserve every version actually used by this selection.
  const sourceVersions: Record<string, number[]> = structuredClone(state.sourceVersions);
  for (const row of input.progress) for (const ref of row.requirement.sourceRefs) {
    sourceVersions[ref.sourceId] = [...new Set([...(sourceVersions[ref.sourceId] ?? []), ref.sourceVersion])].sort((a, b) => a - b);
  }
  return { layer: "activity", parentDecisionId: null, selectedAction: context.action, candidates, reasonCodes, evidenceRefs,
    stateVersion: state.stateVersion, goalVersion: `goal:${input.goal.id}:v${input.goal.revision}`,
    // The route's input snapshot includes requirement definitions, derived progress,
    // origin-bound request and the exact pre-override selector result. No session exists.
    intentVersion: JSON.stringify({ entry: `course-route-${input.entry}`, request: input.request, requestedId: input.requestedId,
      progress: input.progress, excluded: input.excluded, initialStep, context }),
    policyVersion: "course-route-1", sourceVersions, dataAsOf: state.dataAsOf,
    invalidationConditions: ["state_changed", "goal_changed", "intent_changed", "policy_changed", "source_changed"] };
}
