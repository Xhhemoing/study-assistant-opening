import type { EvidenceEligibilityContext, EvidenceHelpExposure, EvidenceObservation } from "./evidence-eligibility-types";

/** Synthetic captured facts only; no learner data and no database adapter. */
export function revisionEvidence(help: Partial<EvidenceHelpExposure> = {}, answerRecordedAt: number | null = 500) {
  const observation: EvidenceObservation = {
    observationId: "observation-v2", courseId: "course", requirementKey: "teaching:block:v2",
    attemptId: "attempt-v2", problemId: "saved-question", itemVersionId: "publication-v2",
    startedAt: 200, submittedAt: 300, assistance: "independent", outcome: "correct", verdictSource: "reference_checked",
  };
  const receipt: EvidenceHelpExposure = {
    attemptId: "attempt-v1", problemId: "saved-question", sameQuestion: true,
    delivered: true, deliveredAt: 100, kind: "hint", level: "hinted", ...help,
  };
  const context: EvidenceEligibilityContext = {
    helpHistory: { complete: true, answerRecordedAt, exposures: [receipt] },
    referenceCheckAuthority: "independent_review",
    referenceCheck: { attemptId: observation.attemptId, problemId: observation.problemId,
      itemVersionId: observation.itemVersionId, referenceId: "reference", method: "independent worked comparison",
      checkerId: "reviewer", scope: "whole_answer", outcome: "correct" },
    version: { applicability: "exact", currentItemVersionId: observation.itemVersionId },
    delayedCheck: { protocolId: "retest", attemptId: observation.attemptId, earliestAt: 200, priorAnswerPolicy: "require_unseen_problem" },
  };
  return { observation, context, receipt };
}

export const privacyIds = {
  workspace: "22222222-2222-4222-8222-222222222222",
  owner: "33333333-3333-4333-8333-333333333333",
  source: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  otherSource: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  root: "44444444-4444-4444-8444-444444444444",
  head: "55555555-5555-4555-8555-555555555555",
} as const;
