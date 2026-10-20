import type {
  EvidenceEligibilityContext,
  EvidenceEligibilityReasonCode,
  EvidenceEligibilityValue,
  EvidenceObservation,
} from "./evidence-eligibility-types";

type Reasons = Set<EvidenceEligibilityReasonCode>;

function knownTime(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

export function evaluateAssistance(
  observation: EvidenceObservation,
  history: EvidenceEligibilityContext["helpHistory"],
  reasons: Reasons,
): { independent: EvidenceEligibilityValue; priorAnswer: EvidenceEligibilityValue; assistance: NonNullable<EvidenceObservation["assistance"]> } {
  const { startedAt, submittedAt } = observation;
  const answerRecordedAt = history?.answerRecordedAt === undefined ? submittedAt : history.answerRecordedAt;
  const timingKnown = knownTime(startedAt) && knownTime(submittedAt) && startedAt <= submittedAt
    && knownTime(answerRecordedAt) && submittedAt <= answerRecordedAt;
  let uncertain = !history?.complete || !timingKnown;
  let assisted = observation.assistance === "hinted" || observation.assistance === "revealed";
  let assistance = observation.assistance ?? "unknown";
  let priorAnswer: EvidenceEligibilityValue = history?.complete ? "no" : "unknown";
  if (!history?.complete) reasons.add("help_history_incomplete");
  if (!timingKnown) reasons.add("attempt_timing_unknown");
  if (assisted) reasons.add("declared_help");
  if (!assisted && observation.assistance !== "independent") {
    uncertain = true;
    reasons.add("assistance_unknown");
  }
  const markUnknown = (reason: EvidenceEligibilityReasonCode) => {
    uncertain = true;
    if (priorAnswer !== "yes") priorAnswer = "unknown";
    reasons.add(reason);
  };
  for (const help of history?.exposures ?? []) {
    if (help.delivered === false) continue;
    if (help.supportDomain === "language" && observation.assessmentDomain !== "language") continue;
    if (help.serverOrder === "after_answer") continue;
    // V2-13: concept instruction must not elevate item assistance / prior answer.
    if ((help.kind ?? "hint") === "instruction") continue;
    const sameAttempt = help.attemptId === observation.attemptId;
    const evaluationFeedback = help.kind === "evaluation_feedback" && help.sameQuestion === true;
    const otherProblem = Boolean(help.problemId && help.problemId !== observation.problemId);
    if (otherProblem && !sameAttempt && !evaluationFeedback) continue;
    // Feedback after this answer was captured never changes its qualification.
    if (!help.serverOrder && knownTime(help.deliveredAt) && knownTime(answerRecordedAt) && help.deliveredAt > answerRecordedAt) continue;
    if (help.delivered == null) {
      markUnknown("help_delivery_unknown");
      continue;
    }
    if (!help.attemptId || !help.problemId || (otherProblem && !evaluationFeedback)) {
      markUnknown("help_association_unknown");
      continue;
    }
    if (!help.serverOrder && (!knownTime(help.deliveredAt) || !knownTime(answerRecordedAt) || help.deliveredAt === answerRecordedAt)) {
      markUnknown("help_order_unknown");
      continue;
    }
    if (evaluationFeedback) {
      assisted = true;
      if (assistance !== "revealed") assistance = "hinted";
      reasons.add("prior_evaluation_feedback");
      continue;
    }
    if (sameAttempt) {
      if (!help.serverOrder && knownTime(startedAt) && knownTime(help.deliveredAt) && help.deliveredAt < startedAt) {
        markUnknown("help_order_unknown");
      } else {
        assisted = true;
        reasons.add("help_before_submission");
        // Keep the declared level unless this delivery has the full timing and
        // association needed to establish a stronger current-attempt exposure.
        if (timingKnown && (help.level === "revealed" || assistance !== "revealed")) assistance = help.level;
      }
    } else if (knownTime(startedAt) && knownTime(help.deliveredAt) && help.deliveredAt < startedAt) {
      // A new attempt does not erase familiarity; it is distinct from help in this attempt.
      if (help.level === "revealed") {
        priorAnswer = "yes";
        reasons.add("prior_answer_exposure");
      }
    } else {
      markUnknown("help_association_unknown");
    }
  }
  return { independent: assisted ? "no" : uncertain ? "unknown" : "yes", priorAnswer, assistance };
}

export function evaluateDelayedCheck(
  observation: EvidenceObservation,
  protocol: EvidenceEligibilityContext["delayedCheck"],
  prerequisites: readonly EvidenceEligibilityValue[],
  priorAnswer: EvidenceEligibilityValue,
  reasons: Reasons,
): EvidenceEligibilityValue {
  const qualifications = [...prerequisites];
  if (protocol?.baselineEstablished === false) { qualifications.push("unknown"); reasons.add("delayed_baseline_not_established"); }
  if (prerequisites.includes("no")) reasons.add("delayed_prerequisite_not_met");
  else if (prerequisites.includes("unknown")) reasons.add("delayed_prerequisite_unknown");
  if (!protocol?.protocolId || !protocol.attemptId || !knownTime(protocol.earliestAt)) {
    reasons.add("delayed_protocol_incomplete");
    qualifications.push("unknown");
  } else if (protocol.attemptId !== observation.attemptId) {
    reasons.add("delayed_protocol_mismatch");
    qualifications.push("unknown");
  } else if (!knownTime(observation.startedAt) || !knownTime(observation.submittedAt) || observation.startedAt > observation.submittedAt) {
    reasons.add("attempt_timing_unknown");
    qualifications.push("unknown");
  } else if (observation.startedAt < protocol.earliestAt) {
    reasons.add("delayed_check_too_early");
    qualifications.push("no");
  }
  if (!protocol || protocol.priorAnswerPolicy === "unknown") {
    reasons.add("delayed_prior_answer_policy_unknown");
    qualifications.push("unknown");
  } else if (protocol.priorAnswerPolicy === "require_unseen_problem" && priorAnswer !== "no") {
    reasons.add("delayed_requires_unseen_problem");
    qualifications.push(priorAnswer === "yes" ? "no" : "unknown");
  }
  return qualifications.includes("no") ? "no" : qualifications.includes("unknown") ? "unknown" : "yes";
}
