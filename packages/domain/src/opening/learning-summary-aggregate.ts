import type { LearningSummaryAggregate } from "@aistudy/contracts";

/** Complete aggregate facts own conclusions; bounded representative evidence only explains them. */
export function summarizeLearningAggregate(group: LearningSummaryAggregate) {
  const comparable = group.identity.requirementKey !== null && group.identity.requirementKey !== "";
  const evidenceCount = comparable ? group.latestAttemptCount : group.sampleCount;
  const qualifiedCount = comparable ? group.latestIndependentVerifiedCurrentCount : group.independentVerifiedCurrentCount;
  const status = group.sampleCount === 0 ? "unobserved" : evidenceCount > 0 && qualifiedCount === evidenceCount ? "observed_independent" : "needs_check";
  const nextAction = group.openChecks.dueCount > 0 ? "complete_due_check" : group.openChecks.inProgressCount > 0 ? "continue_check"
    : status === "unobserved" ? "record_attempt" : status === "observed_independent" ? "continue_independent" : "check_evidence";
  return {
    recentComparableEvidence: { status, evidenceCount, qualifiedCount, comparable },
    historicalSuccess: { count: group.historicalSuccessCount },
    openChecks: group.openChecks, applicability: group.applicabilityCounts, nextAction,
  };
}
export type AggregateLearningSummary = ReturnType<typeof summarizeLearningAggregate>;
