import type {
  EvidenceEligibilityContext,
  EvidenceObservation,
  EvidenceHelpExposure,
} from "./evidence-eligibility-types";

export const observation: EvidenceObservation = {
  courseId: "course-1",
  requirementKey: "requirement-1",
  attemptId: "attempt-2",
  problemId: "problem-1",
  itemVersionId: "version-1",
  startedAt: 200,
  submittedAt: 300,
  assistance: "independent",
  outcome: "correct",
  verdictSource: "reference_checked",
};
export const context: EvidenceEligibilityContext = {
  helpHistory: { complete: true, exposures: [] },
  referenceCheck: {
    attemptId: "attempt-2",
    problemId: "problem-1",
    itemVersionId: "version-1",
    referenceId: "reference-1",
    method: "Worked solution comparison",
    scope: "whole_answer",
    checkerId: "checker-1",
    outcome: "correct",
  },
  version: { applicability: "exact", currentItemVersionId: "version-1" },
  delayedCheck: {
    protocolId: "protocol-1",
    attemptId: "attempt-2",
    earliestAt: 200,
    priorAnswerPolicy: "require_unseen_problem",
  },
};
export const exposure: EvidenceHelpExposure = {
  attemptId: "attempt-2",
  problemId: "problem-1",
  delivered: true,
  deliveredAt: 250,
  level: "hinted",
};
export function withHelp(
  exposures: readonly EvidenceHelpExposure[],
  complete = true,
): EvidenceEligibilityContext {
  return { ...context, helpHistory: { exposures, complete } };
}
