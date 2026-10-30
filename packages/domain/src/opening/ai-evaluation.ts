import type { AiGradingProposal, LearningEvidenceEligibility } from "@aistudy/contracts";
import type { EvidenceEligibilityContext, EvidenceEligibilityReasonCode, EvidenceEligibilityValue, EvidenceObservation } from "./evidence-eligibility-types";
import { proofFeedbackAllowsOutcome } from "./proof-feedback";

/** Product acceptance policy, not a calibrated probability of grading accuracy. */
export const AI_GRADING_MIN_CONFIDENCE = 0.8;

function criteriaAgree(proposal: AiGradingProposal): boolean {
  return proposal.criteria.length > 0 && (proposal.outcome === "correct"
    ? proposal.criteria.every(criterion => criterion.verdict === "correct")
    : proposal.outcome === "incorrect" && proposal.criteria.some(criterion => criterion.verdict === "incorrect"));
}

/** Store uncertain or contradictory feedback without turning it into a binary grade. */
export function acceptedAiGradingOutcome(proposal: AiGradingProposal): AiGradingProposal["outcome"] {
  return proposal.questionMatch && proposal.confidence >= AI_GRADING_MIN_CONFIDENCE
    && proposal.confidence <= 1 && criteriaAgree(proposal)&&proofFeedbackAllowsOutcome(proposal.outcome,proposal.proofFeedback) ? proposal.outcome : "unverified";
}

export function isAiGradedEvidence(eligibility: Pick<LearningEvidenceEligibility, "reasonCodes">): boolean {
  return eligibility.reasonCodes.includes("ai_graded_correct") || eligibility.reasonCodes.includes("ai_graded_incorrect");
}

export function evaluateAiCorrectness(observation: EvidenceObservation,
  evaluation: EvidenceEligibilityContext["aiEvaluation"],
  reasons: Set<EvidenceEligibilityReasonCode>): EvidenceEligibilityValue {
  if (!evaluation || evaluation.evaluatorVersion !== "ai-rubric-v1") {
    reasons.add("ai_evaluation_incomplete"); return "unknown";
  }
  if (!observation.observationId || evaluation.observationId !== observation.observationId
    || evaluation.attemptId !== observation.attemptId || evaluation.problemId !== observation.problemId
    || evaluation.itemVersionId !== observation.itemVersionId
    || evaluation.requirementKey !== (observation.requirementKey ?? null)) {
    reasons.add("ai_evaluation_identity_mismatch"); return "unknown";
  }
  if (!evaluation.questionMatch) { reasons.add("ai_evaluation_question_mismatch"); return "unknown"; }
  if (!(evaluation.confidence >= AI_GRADING_MIN_CONFIDENCE && evaluation.confidence <= 1)) {
    reasons.add("ai_evaluation_low_confidence"); return "unknown";
  }
  if (evaluation.outcome === "unverified") { reasons.add("ai_evaluation_abstained"); return "unknown"; }
  if (!criteriaAgree(evaluation)||!proofFeedbackAllowsOutcome(evaluation.outcome,evaluation.proofFeedback)) { reasons.add("ai_evaluation_criteria_inconsistent"); return "unknown"; }
  if (evaluation.outcome !== observation.outcome) { reasons.add("ai_evaluation_outcome_conflict"); return "unknown"; }
  reasons.add(evaluation.outcome === "correct" ? "ai_graded_correct" : "ai_graded_incorrect");
  reasons.add("ai_evaluation_uncalibrated");
  return "unknown";
}
