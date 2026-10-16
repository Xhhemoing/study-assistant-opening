import type { NextLearningStep, NextLearningStepInput } from "./snapshot-sources";

/** Select the next activity from effective observation heads, newest first. */
export function nextLearningStep(input: NextLearningStepInput): NextLearningStep {
  if (input.wantsFullExplanation) {
    return { activityKind: "full_explain", focusObservationId: null, reasonCode: "requested_full" };
  }

  const latest = input.observations[0];
  if (!latest) {
    return { activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" };
  }

  if (latest.verifiedCorrect === "no") {
    return {
      activityKind: "targeted_explain",
      focusObservationId: latest.id,
      reasonCode: "verified_incorrect",
    };
  }

  if (input.observations.every((observation) => observation.verifiedCorrect === "unknown")) {
    return { activityKind: "diagnose", focusObservationId: null, reasonCode: "unverified_only" };
  }

  const recent = input.observations.slice(0, 3);
  const assistedCount = recent.filter(
    (observation) => observation.assistance === "hinted" || observation.assistance === "revealed",
  ).length;
  if (assistedCount > recent.length / 2) {
    return {
      activityKind: "reduced_help_practice",
      focusObservationId: null,
      reasonCode: "assistance_dependent",
    };
  }

  if (input.status === "observed_independent") {
    return { activityKind: "transfer_check", focusObservationId: null, reasonCode: "independent" };
  }

  return { activityKind: "diagnose", focusObservationId: null, reasonCode: "needs_check" };
}
