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
): { independent: EvidenceEligibilityValue; priorAnswer: EvidenceEligibilityValue } {
  const { startedAt, submittedAt } = observation;
  const answerRecordedAt = history?.answerRecordedAt === undefined ? submittedAt : history.answerRecordedAt;
  const timingKnown = knownTime(startedAt) && knownTime(submittedAt) && startedAt <= submittedAt
    && knownTime(answerRecordedAt) && submittedAt <= answerRecordedAt;
  let uncertain = !history?.complete || !timingKnown;
  let assisted = observation.assistance === "hinted" || observation.assistance === "revealed";
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
    const sameAttempt = help.attemptId === observation.attemptId;
    const otherProblem = Boolean(help.problemId && help.problemId !== observation.problemId);
    if (otherProblem && !sameAttempt) continue;
    // Feedback after this answer was captured never changes its qualification.
    if (knownTime(help.deliveredAt) && knownTime(answerRecordedAt) && help.deliveredAt > answerRecordedAt) continue;
    if (help.delivered == null) {
      markUnknown("help_delivery_unknown");
      continue;
    }
    if (!help.attemptId || !help.problemId || otherProblem) {
      markUnknown("help_association_unknown");
      continue;
    }
    if (!knownTime(help.deliveredAt) || !knownTime(answerRecordedAt) || help.deliveredAt === answerRecordedAt) {
      markUnknown("help_order_unknown");
      continue;
    }
    if (sameAttempt) {
      if (knownTime(startedAt) && help.deliveredAt < startedAt) {
        markUnknown("help_order_unknown");
      } else {
        assisted = true;
        reasons.add("help_before_submission");
      }
    } else if (knownTime(startedAt) && help.deliveredAt < startedAt) {
      // A new attempt does not erase familiarity; it is distinct from help in this attempt.
      if (help.level === "revealed") {
        priorAnswer = "yes";
        reasons.add("prior_answer_exposure");
      }
    } else {
      markUnknown("help_association_unknown");
    }
  }
  return { independent: assisted ? "no" : uncertain ? "unknown" : "yes", priorAnswer };
}

export function evaluateDelayedCheck(
  observation: EvidenceObservation,
  protocol: EvidenceEligibilityContext["delayedCheck"],
  prerequisites: readonly EvidenceEligibilityValue[],
  priorAnswer: EvidenceEligibilityValue,
  reasons: Reasons,
): EvidenceEligibilityValue {
  const qualifications = [...prerequisites];
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
