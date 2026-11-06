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

/** Route-only reason; deliberately not a shared NextStepReasonCode. */
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
  /** The teaching step the route uses: canonical, or the explicit override below. */
  decision: { activityKind: NextLearningStep["activityKind"]; reasonCode: string; focusObservationId: string | null };
  override: CourseRouteTeachingOverride | null;
};

/** Course routes keep their accepted assisted-correction behaviour as an explicit,
 * route-level override instead of borrowing the learner's "consolidate" request.
 * It applies only when the shared policy falls through to diagnose/needs_check
 * while the latest usable, requirement-qualified observation is a verified
 * correct answer reached with a hint or revealed solution and no retest is due.
 * Agenda/span keep the canonical result; the receipt records both.
 */
export function courseRouteTeachingStep(input: NextLearningStepInput): CourseRouteTeachingStep {
  const canonical = captureNextLearningStep(input);
  const { activityKind, reasonCode, focusObservationId } = canonical.decision;
  const latest = input.observations.find(row => row.usableForCurrentVersion === "yes");
  if (input.dueRetest || input.learningPhase || input.wantsFullExplanation || !latest
    || activityKind !== "diagnose" || reasonCode !== "needs_check"
    || latest.verifiedCorrect !== "yes" || (latest.assistance !== "hinted" && latest.assistance !== "revealed")) {
    return { canonical, decision: { activityKind, reasonCode, focusObservationId }, override: null };
  }
  const to = { activityKind: "reduced_help_practice", reasonCode: COURSE_ROUTE_ASSISTED_CORRECTION, focusObservationId: null } as const;
  return { canonical, decision: to, override: { rule: COURSE_ROUTE_ASSISTED_CORRECTION, observationId: latest.id, from: { activityKind, reasonCode, focusObservationId }, to } };
}
