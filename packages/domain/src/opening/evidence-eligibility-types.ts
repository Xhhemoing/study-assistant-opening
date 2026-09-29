/** Local S2 policy inputs. Adapters must supply server-owned facts, not client eligibility claims. */
export type EvidenceEligibilityValue = "yes" | "no" | "unknown";
export type EvidenceVersionApplicability =
  | "exact"
  | "equivalent_confirmed"
  | "changed_needs_check"
  | "version_unknown"
  | "unavailable"
  | "privacy_excluded";

type EvidenceOutcome = "correct" | "incorrect" | "unverified";
interface EvidenceIdentity {
  attemptId?: string | null;
  problemId?: string | null;
  /** Stable identity of the captured item version; never inferred from the current item. */
  itemVersionId?: string | null;
}

export interface EvidenceObservation extends EvidenceIdentity {
  courseId?: string | null;
  requirementKey?: string | null;
  /** Server times in epoch milliseconds; missing historical times remain unknown. */
  startedAt?: number | null;
  submittedAt?: number | null;
  assistance?: "independent" | "hinted" | "revealed" | "unknown" | null;
  outcome?: EvidenceOutcome | null;
  verdictSource?: "self_report" | "reference_checked" | "model_suggestion" | "unknown" | null;
}

export interface EvidenceHelpExposure {
  attemptId?: string | null;
  problemId?: string | null;
  level: "hinted" | "revealed";
  /** Persisted and retrievable by the client, not proof of reading. Null means unknown. */
  delivered: boolean | null;
  deliveredAt?: number | null;
}

export interface EvidenceEligibilityContext {
  helpHistory?: {
    /** Covers this attempt and historical answer exposure for the same problem. */
    complete: boolean;
    /** Latest actual answer revision, used only for help ordering. Undefined keeps original submission; null is unknown. */
    answerRecordedAt?: number | null;
    exposures: readonly EvidenceHelpExposure[];
  } | null;
  referenceCheck?: EvidenceIdentity & {
    referenceId?: string | null;
    method?: string | null;
    scope?: "whole_answer" | "partial" | "unknown" | null;
    checkerId?: string | null;
    outcome?: EvidenceOutcome | null;
  } | null;
  version?: {
    applicability: EvidenceVersionApplicability;
    currentItemVersionId?: string | null;
    equivalence?: {
      confirmationId?: string | null;
      courseId?: string | null;
      requirementKey?: string | null;
      problemId?: string | null;
      fromItemVersionId?: string | null;
      toItemVersionId?: string | null;
    } | null;
  } | null;
  delayedCheck?: {
    protocolId?: string | null;
    attemptId?: string | null;
    /** Earliest permissible start, supplied by the protocol owner. No wall-clock inference. */
    earliestAt?: number | null;
    priorAnswerPolicy: "require_unseen_problem" | "allow_repeated_problem" | "unknown";
  } | null;
}

export type EvidenceEligibilityReasonCode =
  | "observation_identity_incomplete"
  | "attempt_timing_unknown"
  | "help_history_incomplete"
  | "help_delivery_unknown"
  | "help_association_unknown"
  | "help_order_unknown"
  | "help_before_submission"
  | "declared_help"
  | "assistance_unknown"
  | "prior_answer_exposure"
  | "verification_source_untrusted"
  | "reference_check_incomplete"
  | "reference_check_scope_incomplete"
  | "reference_check_identity_mismatch"
  | "reference_check_outcome_conflict"
  | "reference_checked_correct"
  | "reference_checked_incorrect"
  | "outcome_unverified"
  | "version_unknown"
  | "version_exact"
  | "version_exact_mismatch"
  | "version_equivalent_confirmed"
  | "version_equivalence_unconfirmed"
  | "version_changed_needs_check"
  | "version_unavailable"
  | "version_privacy_excluded"
  | "delayed_protocol_incomplete"
  | "delayed_protocol_mismatch"
  | "delayed_check_too_early"
  | "delayed_prior_answer_policy_unknown"
  | "delayed_requires_unseen_problem"
  | "delayed_prerequisite_not_met"
  | "delayed_prerequisite_unknown";

export interface EvidenceEligibility {
  independentAttempt: EvidenceEligibilityValue;
  verifiedCorrect: EvidenceEligibilityValue;
  usableForCurrentVersion: EvidenceEligibilityValue;
  usableForDelayedCheck: EvidenceEligibilityValue;
  reasonCodes: EvidenceEligibilityReasonCode[];
  policyVersion: "opening-evidence-v1";
}
