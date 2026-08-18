import type { LearningEvent } from "@aistudy/contracts";
import { reviewGradeToEvidence, type EvidenceEvent, type StatusCorrection } from "./status";

export function evidenceFromLearningEvent(event: LearningEvent): EvidenceEvent | null {
  if (event.type === "attempt") {
    return {
      correct: event.payload.correct,
      assisted: event.payload.assisted,
      hintCount: event.payload.hintCount,
      confidence: event.payload.confidence,
      slice: event.payload.abilitySlice,
      occurredAt: event.occurredAt,
      source: "attempt",
      excludeFromAssessment: false,
      errorCause: event.payload.errorCause,
    };
  }
  if (event.type === "review") {
    if (event.payload.excludeFromAssessment) return null;
    return {
      ...reviewGradeToEvidence(event.payload.grade, event.occurredAt),
      assisted: event.payload.assisted,
      excludeFromAssessment: false,
    };
  }
  return null;
}

export function correctionFromLearningEvent(event: LearningEvent): StatusCorrection | null {
  if (event.type !== "correction" || event.payload.kind !== "status" || !event.syllabusPointId) {
    return null;
  }
  return {
    syllabusPointId: event.syllabusPointId,
    note: event.payload.note,
    overrideStatus: event.payload.overrideStatus ?? null,
    createdAt: event.occurredAt,
  };
}
