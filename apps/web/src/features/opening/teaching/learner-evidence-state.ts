import type { LearningObservation } from "@aistudy/contracts";

export type LearnerEvidenceState = "independent" | "hinted" | "retest" | "insufficient";
export const learnerEvidenceLabels: Record<LearnerEvidenceState, string> = {
  independent: "独立完成", hinted: "依赖提示", retest: "待复测", insufficient: "证据不足",
};

/** Present the server's qualification of this observation, not course mastery. */
export function learnerEvidenceState(observation: LearningObservation | null | undefined): LearnerEvidenceState {
  const eligibility = observation?.eligibility;
  if (!observation || observation.revisionKind === "retract" || (observation.effectiveHeadId && observation.effectiveHeadId !== observation.id)
    || !eligibility || eligibility.usableForCurrentVersion !== "yes") return "insufficient";
  if (observation.assistance === "revealed" || eligibility.reasonCodes.includes("prior_answer_exposure") || eligibility.verifiedCorrect === "no") return "retest";
  if (eligibility.verifiedCorrect !== "yes") return "insufficient";
  if (eligibility.independentAttempt === "yes" && observation.assistance === "independent") return "independent";
  if (eligibility.independentAttempt === "no" && observation.assistance === "hinted") return "hinted";
  return "insufficient";
}
