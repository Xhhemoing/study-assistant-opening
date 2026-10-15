import type { LearningObservation, LearningSummary } from "@aistudy/contracts";
import type { ObservationEligibilityInput } from "../learning-summary";

/** Captured evidence plus the server-owned facts required by the existing policy. */
export type SkillEvidence = Readonly<{
  observationId: string;
  courseId: string;
  skillLabel: string;
  requirementKey: string | null;
  itemVersionId: string | null;
  /** Null means the attempt history does not establish whether this was the first attempt. */
  firstAttempt: boolean | null;
  outcome: LearningObservation["outcome"];
  assistance: LearningObservation["assistance"];
  verdictSource: LearningObservation["verdictSource"];
  occurredAt: string;
  /** Preserve original submission/revision times and provenance without reconstructing a record. */
  record: LearningObservation;
  /** Missing historical qualification remains unknown; never infer it from the scalar labels. */
  eligibilityInput: ObservationEligibilityInput | null;
}>;

export type SkillStateEstimate = { state: LearningSummary["status"]; reasons: string[] };

/** One workspace/course/requirement/skill group per estimate; empty input is unobserved. */
export interface SkillStateEstimator {
  readonly version: string;
  estimate(evidence: readonly SkillEvidence[]): SkillStateEstimate;
}
