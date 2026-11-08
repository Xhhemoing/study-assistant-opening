import type { CourseRequirement } from "@aistudy/contracts";
import { buildDecisionInput, captureNextLearningStep, type CourseRouteObservation, type NextLearningStep, type NextLearningStepInput } from "@aistudy/domain";

/** Keep requirement/revision qualification and explicit-origin continuation.
 * Scope facts before canonical ordering; never manufacture a newer timestamp.
 * The result is the canonical input only: no phase control is injected here.
 */
export function courseRouteDecisionInput(requirement: CourseRequirement, observations: readonly CourseRouteObservation[], options: { dueRetest?: boolean; origin?: CourseRouteObservation } = {}): NextLearningStepInput {
  let matching = observations.filter(row => row.usableForCurrentVersion === "yes" && (
    row.requirementKey === requirement.requirementKey && row.courseRequirement?.id === requirement.id
      && row.courseRequirement.revision === requirement.revision && row.courseRequirement.stableSkillId === requirement.stableSkillId
      && row.courseRequirement.requirementKey === requirement.requirementKey
    || row.sharedFor?.some(ref => ref.requirementId === requirement.id && ref.requirementRevision === requirement.revision
      && ref.stableSkillId === requirement.stableSkillId)));
  const origin = options.origin && matching.find(row => row.id === options.origin!.id);
  if (origin) matching = matching.filter(row => row.id === origin.id || Date.parse(row.attemptedAt) < Date.parse(origin.attemptedAt));
  // Preserve the existing rule: local errors/non-independent work cannot be
  // hidden by a cross-course success. Do not promote shared evidence here.
  const local = [...matching].filter(row => !row.sharedFor?.length)
    .sort((a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || b.id.localeCompare(a.id))[0];
  if (local && (local.verifiedCorrect !== "yes" || local.assistance !== "independent")) {
    matching = matching.filter(row => !row.sharedFor?.length);
  }
  return buildDecisionInput({ observations: matching, wantsFullExplanation: false, ...(options.dueRetest ? { dueRetest: true } : {}) });
}

/** Historical route-only reason, retained for interpreting stored overrides. */
export const COURSE_ROUTE_ASSISTED_CORRECTION = "route_assisted_correction";
export type CourseRouteTeachingOverride = {
  rule: typeof COURSE_ROUTE_ASSISTED_CORRECTION;
  observationId: string;
  from: Pick<NextLearningStep, "activityKind" | "reasonCode" | "focusObservationId">;
  to: { activityKind: "reduced_help_practice"; reasonCode: typeof COURSE_ROUTE_ASSISTED_CORRECTION; focusObservationId: null };
};
export type CourseRouteTeachingStep = {
  /** Exactly what the shared policy returns for the canonical input. */
  canonical: ReturnType<typeof captureNextLearningStep>;
  /** New route decisions use the shared policy without a route-only override. */
  decision: { activityKind: NextLearningStep["activityKind"]; reasonCode: string; focusObservationId: string | null };
  override: CourseRouteTeachingOverride | null;
};

/** Assisted success is owned by the shared policy. Historical overrides remain
 * readable in stored receipts; selecting a new step never recreates them.
 */
export function courseRouteTeachingStep(input: NextLearningStepInput): CourseRouteTeachingStep {
  const canonical = captureNextLearningStep(input);
  const { activityKind, reasonCode, focusObservationId } = canonical.decision;
  return { canonical, decision: { activityKind, reasonCode, focusObservationId }, override: null };
}
