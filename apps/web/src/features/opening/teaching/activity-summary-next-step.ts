import type { TeachingActivitySummary } from "@aistudy/contracts";
import { buildDecisionInput, nextLearningStep, type SnapshotObservation } from "@aistudy/domain";

export function activitySummaryNextStep(observations: readonly SnapshotObservation[]): TeachingActivitySummary["nextStep"] {
  const input = buildDecisionInput({ observations, wantsFullExplanation: false });
  const latest = input.observations.find(row => row.usableForCurrentVersion === "yes");
  if (!latest || latest.verifiedCorrect !== "yes") return undefined;
  const { reasonCode } = nextLearningStep(input);
  if (reasonCode === "assisted_success") return { kind: "assisted_check", observationId: latest.id };
  if (reasonCode === "independent" && latest.assistance === "independent" && latest.independentAttempt === "yes") {
    return { kind: "schedule_retest", observationId: latest.id };
  }
  return undefined;
}
