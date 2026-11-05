import type { NextLearningStepInput, SnapshotObservation } from "./snapshot-sources";

/** Facts must already be scoped, effective and version-qualified by their repository.
 * This builder never reads state, grants eligibility or infers independent success.
 * Keep unavailable evidence distinct from an empty successful read at the caller.
 */
export function buildDecisionInput(input: Omit<NextLearningStepInput, "status" | "observations"> & {
  observations: readonly SnapshotObservation[];
}): NextLearningStepInput {
  const observations = [...input.observations].sort((a, b) =>
    Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt) || a.id.localeCompare(b.id));
  const latest = observations.find(row => row.usableForCurrentVersion === "yes");
  return {
    ...input,
    observations,
    status: !latest ? "unobserved" : latest.verifiedCorrect === "yes" && latest.independentAttempt === "yes"
      ? "observed_independent" : "needs_check",
  };
}
