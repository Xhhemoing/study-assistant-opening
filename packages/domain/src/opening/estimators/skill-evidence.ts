import type { LearningObservation } from "@aistudy/contracts";
import type { ObservationEligibilityInput } from "../learning-summary";
import type { SkillEvidence } from "./types";

/** Adapts persisted facts without guessing first-attempt or qualification history. */
export function toSkillEvidence(
  record: LearningObservation,
  eligibilityInput: ObservationEligibilityInput | null,
  firstAttempt: boolean | null = null,
): SkillEvidence {
  return {
    observationId: record.id,
    courseId: record.courseId,
    skillLabel: record.skillLabel,
    requirementKey: eligibilityInput?.observation.requirementKey ?? record.requirementKey ?? null,
    itemVersionId: record.itemVersionId ?? eligibilityInput?.observation.itemVersionId ?? null,
    firstAttempt,
    outcome: record.outcome,
    assistance: record.assistance,
    verdictSource: record.verdictSource,
    occurredAt: record.occurredAt,
    record,
    eligibilityInput,
  };
}
