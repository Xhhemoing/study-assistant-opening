import type { LearningObservation } from "@aistudy/contracts";
import { learnerEvidenceDisplayLabels, learnerEvidenceDisplayState, type LearnerEvidenceDisplayState } from "@aistudy/domain";

export type LearnerEvidenceState = LearnerEvidenceDisplayState;
export const learnerEvidenceLabels = learnerEvidenceDisplayLabels;

/** Only an effective, non-retracted observation can supply a learner-facing state. */
export function learnerEvidenceState(observation: LearningObservation | null | undefined): LearnerEvidenceState {
  if (observation?.revisionKind === "retract" || (observation?.effectiveHeadId && observation.effectiveHeadId !== observation.id)) return "insufficient";
  return learnerEvidenceDisplayState(observation);
}
