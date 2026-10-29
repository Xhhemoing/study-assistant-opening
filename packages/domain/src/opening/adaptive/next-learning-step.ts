import type { LearningDecisionCandidate } from "../learning-decision";
import type { NextLearningStep, NextLearningStepInput } from "./snapshot-sources";

export const NEXT_LEARNING_STEP_VERSION = "next-learning-step-1";

/** Capture only branches actually evaluated, in priority order; later rules did not compete. */
export function captureNextLearningStep(input: NextLearningStepInput): {
  decision: NextLearningStep; candidates: LearningDecisionCandidate[];
} {
  const candidates: LearningDecisionCandidate[] = [];
  const check = (action: NextLearningStep["activityKind"], eligible: boolean, reason: string, rejected: string, evidenceRefs: string[] = []) => {
    candidates.push({ action, eligible, reasonCodes: [eligible ? reason : rejected], evidenceRefs });
    return eligible;
  };
  const result = (activityKind: NextLearningStep["activityKind"], reasonCode: NextLearningStep["reasonCode"], focusObservationId: string | null = null) =>
    ({ decision: { activityKind, focusObservationId, reasonCode }, candidates });
  if (check("full_explain", !!input.wantsFullExplanation, "requested_full", "not_requested_full")) return result("full_explain", "requested_full");
  const observations = input.observations.filter(row => row.usableForCurrentVersion === "yes");
  const latest = observations[0], refs = observations.map(row => `observation:${row.id}`);
  if (check("diagnose", !latest, "no_evidence", "has_current_evidence", refs)) return result("diagnose", "no_evidence");
  if (check("targeted_explain", latest!.verifiedCorrect === "no", "verified_incorrect", "latest_not_verified_incorrect", [`observation:${latest!.id}`]))
    return result("targeted_explain", "verified_incorrect", latest!.id);
  if (check("diagnose", observations.every(row => row.verifiedCorrect === "unknown"), "unverified_only", "has_verified_evidence", refs)) return result("diagnose", "unverified_only");
  const recent = observations.slice(0, 3);
  const assistedCount = recent.filter(row => row.assistance === "hinted" || row.assistance === "revealed").length;
  if (check("reduced_help_practice", assistedCount > recent.length / 2, "assistance_dependent", "no_assisted_majority", recent.map(row => `observation:${row.id}`)))
    return result("reduced_help_practice", "assistance_dependent");
  if (check("transfer_check", input.status === "observed_independent", "independent", "not_observed_independent", refs)) return result("transfer_check", "independent");
  if (check("transfer_check", latest!.verifiedCorrect === "yes" && latest!.independentAttempt === "unknown"
    && latest!.assistance !== "hinted" && latest!.assistance !== "revealed", "correct_needs_independent_check", "no_unknown_independence_check", [`observation:${latest!.id}`]))
    return result("transfer_check", "correct_needs_independent_check");
  check("diagnose", true, "needs_check", "needs_check", refs);
  return result("diagnose", "needs_check");
}

/** Select the next activity from effective observation heads, newest first. */
export function nextLearningStep(input: NextLearningStepInput): NextLearningStep {
  return captureNextLearningStep(input).decision;
}
