import type { NextLearningStep, NextLearningStepInput } from "./snapshot-sources";

/** Select the next activity from effective observation heads, newest first. */
export function nextLearningStep(input: NextLearningStepInput): NextLearningStep {
  if (input.wantsFullExplanation) {
    return { activityKind: "full_explain", focusObservationId: null, reasonCode: "requested_full" };
  }

  // Historical errors and help remain visible, but do not select current teaching.
  const observations = input.observations.filter(row => row.usableForCurrentVersion === "yes");
  const latest = observations[0];
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

  if (observations.every((observation) => observation.verifiedCorrect === "unknown")) {
    return { activityKind: "diagnose", focusObservationId: null, reasonCode: "unverified_only" };
  }

  const recent = observations.slice(0, 3);
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

  // A readable photo can establish correctness without proving when it was
  // written. Ask for a fresh independent exercise instead of repeating diagnosis.
  if (latest.verifiedCorrect === "yes" && latest.independentAttempt === "unknown"
    && latest.assistance !== "hinted" && latest.assistance !== "revealed") {
    return { activityKind: "transfer_check", focusObservationId: null, reasonCode: "correct_needs_independent_check" };
  }

  return { activityKind: "diagnose", focusObservationId: null, reasonCode: "needs_check" };
}
