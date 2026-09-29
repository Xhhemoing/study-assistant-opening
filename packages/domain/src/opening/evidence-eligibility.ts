import { evaluateAssistance, evaluateDelayedCheck } from "./evidence-eligibility-timing";
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

function evaluateCorrectness(
  observation: EvidenceObservation,
  check: EvidenceEligibilityContext["referenceCheck"],
  reasons: Reasons,
): EvidenceEligibilityValue {
  if (observation.verdictSource !== "reference_checked") {
    reasons.add("verification_source_untrusted");
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
  // A documented reference check qualifies within its scope; this does not claim objective grading.
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
    policyVersion: "opening-evidence-v1",
  };
  if (!observation.attemptId || !observation.problemId || !observation.itemVersionId) {
    result.reasonCodes.push("observation_identity_incomplete");
    return result;
  }
  const reasons: Reasons = new Set();
  const assistance = evaluateAssistance(observation, context.helpHistory, reasons);
  result.independentAttempt = assistance.independent;
  result.verifiedCorrect = evaluateCorrectness(observation, context.referenceCheck, reasons);
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
