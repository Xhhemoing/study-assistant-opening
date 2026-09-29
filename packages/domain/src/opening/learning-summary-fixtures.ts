import type { LearningObservation } from "@aistudy/contracts";
import type { CourseEvidence, ObservationEligibilityInput } from "./learning-summary";
import { observation, context, exposure } from "./evidence-eligibility-fixtures";

export const learningObservation: LearningObservation = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  sessionId: "55555555-5555-4555-8555-555555555555",
  courseId: "33333333-3333-4333-8333-333333333333",
  skillLabel: "fractions",
  sourceIds: ["77777777-7777-4777-8777-777777777777"],
  problemId: "66666666-6666-4666-8666-666666666666",
  answer: "1/2",
  outcome: "correct",
  assistance: "independent",
  clientKey: "client-key-01",
  occurredAt: "2026-09-14T10:00:00.000Z",
  sourceTurnIds: [],
  verdictSource: "reference_checked",
  referenceSourceId: "77777777-7777-4777-8777-777777777777",
  evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
};

export const qualifiedInput: ObservationEligibilityInput = {
  observation: { ...observation, courseId: learningObservation.courseId },
  context,
};

export function courseEvidence(input: ObservationEligibilityInput | null = qualifiedInput): CourseEvidence {
  return {
    observations: [{ ...learningObservation }],
    evidenceContexts: input ? { [learningObservation.id]: input } : {},
  };
}

export const courseEvidenceCases: Array<{ name: string; evidence: CourseEvidence; independent: boolean }> = [
  { name: "documented independent reference check", evidence: courseEvidence(), independent: true },
  { name: "legacy identity missing", evidence: courseEvidence(null), independent: false },
  { name: "reference_checked label without method", evidence: courseEvidence({ ...qualifiedInput, context: { ...context, referenceCheck: null } }), independent: false },
  { name: "self-reported correct", evidence: courseEvidence({ ...qualifiedInput, observation: { ...qualifiedInput.observation, verdictSource: "self_report" } }), independent: false },
  { name: "source changed", evidence: courseEvidence({ ...qualifiedInput, context: { ...context, version: { applicability: "changed_needs_check" } } }), independent: false },
  { name: "help before submission", evidence: courseEvidence({ ...qualifiedInput, context: { ...context, helpHistory: { complete: true, exposures: [exposure] } } }), independent: false },
  { name: "help after submission", evidence: courseEvidence({ ...qualifiedInput, context: { ...context, helpHistory: { complete: true, exposures: [{ ...exposure, deliveredAt: 350 }] } } }), independent: true },
  { name: "source unavailable", evidence: courseEvidence({ ...qualifiedInput, context: { ...context, version: { applicability: "unavailable" } } }), independent: false },
  { name: "source privacy excluded", evidence: courseEvidence({ ...qualifiedInput, context: { ...context, version: { applicability: "privacy_excluded" } } }), independent: false },
];
