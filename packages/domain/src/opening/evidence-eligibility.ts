import { evaluateAssistance, evaluateDelayedCheck } from "./evidence-eligibility-timing";
import { evaluateAiCorrectness } from "./ai-evaluation";
import type {
  EvidenceEligibility,
  EvidenceEligibilityContext,
  EvidenceEligibilityReasonCode,
  EvidenceEligibilityValue,
  EvidenceObservation,
} from "./evidence-eligibility-types";

export type {
  EvidenceEligibility,
  EvidenceEligibilityContext,
  EvidenceEligibilityReasonCode,
  EvidenceEligibilityValue,
  EvidenceHelpExposure,
  EvidenceObservation,
  EvidenceVersionApplicability,
} from "./evidence-eligibility-types";

type Reasons = Set<EvidenceEligibilityReasonCode>;

/** Effective current-attempt help; a self-report cannot erase an established delivery. */
export function resolveEvidenceAssistance(observation: EvidenceObservation, context: EvidenceEligibilityContext) {
  if (context.selfReportedAnswerConditions?.copiedAnswer) return "revealed" as const;
  const assistance = evaluateAssistance(observation, context.helpHistory, new Set()).assistance;
  if (assistance === "revealed") return assistance;
  if (context.examAttempt?.lessonAssistance === true || context.examAttempt?.partialExample === true) return "hinted" as const;
  if (assistance === "hinted") return assistance;
  if (context.examAttempt && (context.examAttempt.lessonAssistance === null
    || context.examAttempt.partialExample === null
    || context.examAttempt.firstFamilyExposure === null || context.examAttempt.exposureCoverage !== undefined)) return "unknown" as const;
  return assistance;
}

function evaluateCorrectness(
  observation: EvidenceObservation,
  check: EvidenceEligibilityContext["referenceCheck"],
  reasons: Reasons,
  automatic: EvidenceEligibilityContext["serverEvaluation"],
  authority: EvidenceEligibilityContext["referenceCheckAuthority"],
): EvidenceEligibilityValue {
  if (observation.verdictSource === "deterministic") {
    const supported = automatic && (
      automatic.evaluatorVersion === "matrix-exact-v1" && automatic.specVersion === "matrix-arithmetic-v1"
      || automatic.evaluatorVersion === "exam-choice-exact-v1" && automatic.specVersion === "exam-choice-v1"
      || automatic.evaluatorVersion === "span-exact-v1" && automatic.specVersion === "span-v1"
    );
    if (!automatic || !supported || automatic.evaluatorVersion === "span-exact-v1" && automatic.decision === "correct" && automatic.coreEvidenceComplete !== true) {
      reasons.add("server_evaluation_incomplete"); return "unknown";
    }
    if (!observation.observationId || automatic.observationId !== observation.observationId
      || automatic.attemptId !== observation.attemptId || automatic.problemId !== observation.problemId
      || automatic.itemVersionId !== observation.itemVersionId || automatic.requirementKey !== observation.requirementKey) {
      reasons.add("server_evaluation_identity_mismatch"); return "unknown";
    }
    if (automatic.decision === "abstain") { reasons.add("server_evaluation_abstained"); return "unknown"; }
    if (automatic.outcome !== observation.outcome || automatic.decision !== automatic.outcome) {
      reasons.add("server_evaluation_outcome_conflict"); return "unknown";
    }
    reasons.add(automatic.outcome === "correct" ? "deterministic_correct" : "deterministic_incorrect");
    return automatic.outcome === "correct" ? "yes" : "no";
  }
  if (observation.verdictSource !== "reference_checked") {
    reasons.add("verification_source_untrusted");
    if (observation.verdictSource === "self_report" && check) reasons.add("learner_reference_compare");
    return "unknown";
  }
  if (!check?.referenceId || !check.method || !check.checkerId || !check.outcome) {
    reasons.add("reference_check_incomplete");
    return "unknown";
  }
  if (check.attemptId !== observation.attemptId || check.problemId !== observation.problemId || check.itemVersionId !== observation.itemVersionId) {
    reasons.add("reference_check_identity_mismatch");
    return "unknown";
  }
  if (check.scope !== "whole_answer") {
    reasons.add("reference_check_scope_incomplete");
    return "unknown";
  }
  if (check.outcome !== observation.outcome) {
    reasons.add("reference_check_outcome_conflict");
    return "unknown";
  }
  if (check.outcome === "unverified") {
    reasons.add("outcome_unverified");
    return "unknown";
  }
  if (authority === "learner" || /^learner_self_compare(?:\s|$)/.test(check.method)) {
    reasons.add("learner_reference_compare");
    return "unknown";
  }
  if (authority !== "independent_review") {
    reasons.add("reference_check_authority_unknown");
    return "unknown";
  }
  // A trusted server context can establish an independently reviewed reference check.
  reasons.add(check.outcome === "correct" ? "reference_checked_correct" : "reference_checked_incorrect");
  return check.outcome === "correct" ? "yes" : "no";
}

function evaluateVersion(
  observation: EvidenceObservation,
  version: EvidenceEligibilityContext["version"],
  reasons: Reasons,
): EvidenceEligibilityValue {
  if (!version || version.applicability === "version_unknown") {
    reasons.add("version_unknown");
    return "unknown";
  }
  if (version.applicability === "unavailable" || version.applicability === "privacy_excluded") {
    reasons.add(version.applicability === "unavailable" ? "version_unavailable" : "version_privacy_excluded");
    return "no";
  }
  if (version.applicability === "changed_needs_check") {
    reasons.add("version_changed_needs_check");
    return "unknown";
  }
  if (version.applicability === "exact") {
    const exact = version.currentItemVersionId === observation.itemVersionId;
    reasons.add(exact ? "version_exact" : "version_exact_mismatch");
    return exact ? "yes" : "unknown";
  }
  const confirmation = version.equivalence;
  const equivalent = Boolean(
    confirmation?.confirmationId && observation.courseId && observation.requirementKey &&
    confirmation.courseId === observation.courseId &&
    confirmation.requirementKey === observation.requirementKey &&
    confirmation.problemId === observation.problemId &&
    confirmation.fromItemVersionId === observation.itemVersionId &&
    version.currentItemVersionId && confirmation.toItemVersionId === version.currentItemVersionId,
  );
  reasons.add(equivalent ? "version_equivalent_confirmed" : "version_equivalence_unconfirmed");
  return equivalent ? "yes" : "unknown";
}

/** Pure qualification of captured facts. Does not replace them or infer mastery. */
export function evaluateEvidenceEligibility(
  observation: EvidenceObservation,
  context: EvidenceEligibilityContext,
): EvidenceEligibility {
  const result: EvidenceEligibility = {
    independentAttempt: "unknown",
    verifiedCorrect: "unknown",
    usableForCurrentVersion: "unknown",
    usableForDelayedCheck: "unknown",
    reasonCodes: [],
    policyVersion: "opening-evidence-v3",
  };
  if (!observation.attemptId || !observation.problemId || !observation.itemVersionId) {
    result.reasonCodes.push("observation_identity_incomplete");
    return result;
  }
  const reasons: Reasons = new Set();
  const assistance = evaluateAssistance(observation, context.helpHistory, reasons);
  result.independentAttempt = assistance.independent;
  if (context.selfReportedAnswerConditions?.copiedAnswer) {
    result.independentAttempt = "no";
    reasons.add("self_reported_copied_answer");
  }
  if (context.selfReportedAnswerConditions?.reportedGuess) {
    if (result.independentAttempt !== "no") result.independentAttempt = "unknown";
    reasons.add("self_reported_guess");
  }
  if (context.examAttempt?.lessonAssistance === true) {
    result.independentAttempt = "no";
    reasons.add("exam_lesson_assistance");
  }
  if (context.examAttempt && (context.examAttempt.lessonAssistance === null
    || context.examAttempt.firstFamilyExposure === null || context.examAttempt.partialExample === null)) {
    if (result.independentAttempt !== "no") result.independentAttempt = "unknown";
    reasons.add("exam_exposure_history_unknown");
  }
  if (context.examAttempt?.exposureCoverage !== undefined) {
    if (result.independentAttempt !== "no") result.independentAttempt = "unknown";
    reasons.add(context.examAttempt.exposureCoverage === "legacy_untracked_source"
      ? "exam_legacy_untracked_source" : "exam_exposure_history_unknown");
  }
  if (context.examAttempt?.partialExample === true) {
    result.independentAttempt = "no";
    reasons.add("exam_partial_example_exposure");
  }
  if (context.examAttempt?.firstFamilyExposure === false) {
    result.independentAttempt = "no";
    reasons.add("exam_family_already_seen");
  }
  if (context.examAttempt) {
    if (context.examAttempt.answerUnchanged === false) {
      result.independentAttempt = "no";
      reasons.add("exam_answer_changed");
    } else if (context.examAttempt.answerUnchanged !== true) {
      if (result.independentAttempt !== "no") result.independentAttempt = "unknown";
      reasons.add("exam_answer_history_unknown");
    }
  }
  result.verifiedCorrect = observation.verdictSource === "ai_graded"
    ? evaluateAiCorrectness(observation, context.aiEvaluation, reasons)
    : evaluateCorrectness(observation, context.referenceCheck, reasons, context.serverEvaluation, context.referenceCheckAuthority);
  result.usableForCurrentVersion = evaluateVersion(observation, context.version, reasons);
  result.usableForDelayedCheck = evaluateDelayedCheck(
    observation,
    context.delayedCheck,
    [result.independentAttempt, result.verifiedCorrect, result.usableForCurrentVersion],
    assistance.priorAnswer,
    reasons,
  );
  result.reasonCodes = [...reasons].sort();
  return result;
}
