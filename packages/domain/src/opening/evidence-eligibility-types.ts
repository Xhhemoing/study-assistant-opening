import type { AiEvaluation, ServerEvaluation } from "@aistudy/contracts";
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
  observationId?: string | null;
  courseId?: string | null;
  assessmentDomain?: "language" | "math" | "unknown";
  requirementKey?: string | null;
  /** Server times in epoch milliseconds; missing historical times remain unknown. */
  startedAt?: number | null;
  submittedAt?: number | null;
  assistance?: "independent" | "hinted" | "revealed" | "unknown" | null;
  outcome?: EvidenceOutcome | null;
  verdictSource?: "self_report" | "reference_checked" | "model_suggestion" | "unknown" | "deterministic" | "ai_graded" | null;
}

export interface EvidenceHelpExposure {
  supportDomain?: "language" | "math" | "unknown";
  /** Determined from transaction-serialized server revisions, never client clocks. */
  serverOrder?: "before_answer" | "after_answer";
  attemptId?: string | null;
  problemId?: string | null;
  level: "hinted" | "revealed";
  /** V2-13: instruction | hint | solution. Missing/legacy reads as hint. */
  kind?: "instruction" | "hint" | "solution" | "evaluation_feedback" | null;
  /** Server canonical catalogue comparison; not a learner-supplied identity. */
  sameQuestion?: boolean;
  /** Persisted and retrievable by the client, not proof of reading. Null means unknown. */
  delivered: boolean | null;
  deliveredAt?: number | null;
}

export interface EvidenceEligibilityContext {
  /** Learner reports about the original answer conditions; they never change its mathematical verdict. */
  selfReportedAnswerConditions?: { copiedAnswer: boolean; reportedGuess: boolean };
  serverEvaluation?: ServerEvaluation | null;
  aiEvaluation?: AiEvaluation | null;
  /** Immutable server capture from the exam bridge, including pre-binding family exposure. */
  examAttempt?: {
    firstFamilyExposure: boolean | null;
    /** Server-verified frozen Sprint lesson references; null means unprovable. */
    lessonAssistance?: boolean | null;
    /** Partial example exposure remains distinct from a complete worked family. */
    partialExample?: boolean | null;
    /** Frozen Sprint source coverage, verified against the original bound source. */
    exposureCoverage?: "legacy_untracked_source" | "unverifiable";
    /** Every ancestor still has the captured answer; null means the chain cannot be proved. */
    answerUnchanged: boolean | null;
  } | null;
  /** Assembled by the server, never read from user-provided reference-check JSON. */
  referenceCheckAuthority?: "learner" | "independent_review" | null;
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
    /** Tracked in-product support; never proof that no offline revision happened. */
    baselineEstablished?: boolean;
    intervalExposure?: { from: number; to: number; recordedCount: number; recordedPracticeCount?: number; complete: boolean };
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
  | "self_reported_copied_answer"
  | "self_reported_guess"
  | "declared_help"
  | "assistance_unknown"
  | "prior_answer_exposure"
  | "prior_evaluation_feedback"
  | "exam_family_already_seen"
  | "exam_lesson_assistance"
  | "exam_exposure_history_unknown"
  | "exam_legacy_untracked_source"
  | "exam_partial_example_exposure"
  | "exam_answer_changed"
  | "exam_answer_history_unknown"
  | "verification_source_untrusted"
  | "learner_reference_compare"
  | "reference_check_authority_unknown"
  | "server_evaluation_incomplete"
  | "server_evaluation_identity_mismatch"
  | "server_evaluation_outcome_conflict"
  | "server_evaluation_abstained"
  | "deterministic_correct"
  | "deterministic_incorrect"
  | "ai_evaluation_incomplete"
  | "ai_evaluation_identity_mismatch"
  | "ai_evaluation_outcome_conflict"
  | "ai_evaluation_question_mismatch"
  | "ai_evaluation_low_confidence"
  | "ai_evaluation_abstained"
  | "ai_evaluation_criteria_inconsistent"
  | "ai_graded_correct"
  | "ai_graded_incorrect"
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
  | "delayed_baseline_not_established"
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
  policyVersion: "opening-evidence-v1" | "opening-evidence-v2" | "opening-evidence-v3";
}
