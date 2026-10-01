import type { LearningSummary } from "@aistudy/contracts";
import type { QualifiedLearningSummary } from "@aistudy/domain";

type Evidence = NonNullable<LearningSummary["evidenceEligibility"]>[number];
const REPRESENTATIVE_LIMIT = 20;

/** HTTP-only projection after full evaluation; worker/domain summaries remain complete. */
export function projectLearningSummaryResponse(summary: QualifiedLearningSummary): LearningSummary {
  if (summary.evidenceIds.length <= REPRESENTATIVE_LIMIT) return summary;
  const byId = new Map(summary.evidenceEligibility.map(entry => [entry.observationId, entry]));
  const ordered = [...summary.evidenceIds].sort().map(id => byId.get(id)!);
  const recentIds = new Set(summary.recentPerformance?.evidenceIds ?? []);
  const recent = ordered.filter(entry => recentIds.has(entry.observationId));
  const selected = new Set<string>();
  function take(entry: Evidence | undefined) {
    if (entry && selected.size < REPRESENTATIVE_LIMIT) selected.add(entry.observationId);
  }
  // Keep current context and a historical counterexample before filling remaining places.
  take(recent[0]);
  take(ordered.find(entry => !recentIds.has(entry.observationId) && entry.eligibility.verifiedCorrect === "no"));
  const explanations: Array<(entry: Evidence) => boolean> = [
    entry => entry.eligibility.verifiedCorrect === "no",
    entry => entry.eligibility.verifiedCorrect === "unknown",
    entry => entry.eligibility.independentAttempt === "no",
    entry => entry.eligibility.independentAttempt === "unknown",
    entry => entry.eligibility.usableForCurrentVersion === "no",
    entry => entry.eligibility.usableForCurrentVersion === "unknown",
    entry => entry.versionApplicability === "unavailable",
    entry => entry.versionApplicability === "privacy_excluded",
  ];
  for (const explains of explanations) {
    take(recent.find(explains));
    take(ordered.find(explains));
  }
  for (const entry of recent) take(entry);
  for (const entry of ordered) take(entry);
  const evidenceIds = [...selected].sort();
  return {
    ...summary,
    evidenceIds,
    evidenceEligibility: evidenceIds.map(id => byId.get(id)!),
    ...(summary.recentPerformance ? { recentPerformance: {
      ...summary.recentPerformance,
      evidenceIds: evidenceIds.filter(id => recentIds.has(id)),
      evidenceCount: summary.recentPerformance.evidenceIds.length,
    } } : {}),
  };
}
