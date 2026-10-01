import type { LearningObservation, LearningSummary } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "./evidence-eligibility";
import type { EvidenceEligibility, EvidenceEligibilityContext, EvidenceObservation, EvidenceVersionApplicability } from "./evidence-eligibility";

export type ObservationEligibilityInput = {
  observation: EvidenceObservation;
  context: EvidenceEligibilityContext;
};

export type CourseEvidence = {
  observations: LearningObservation[];
  evidenceContexts: Record<string, ObservationEligibilityInput>;
};

export type RetestEvidenceIdentity = { courseId: string; requirementKey: string | null; skillLabel: string };

export type SummarizeOptions = {
  /** Due/accepted evidence remains scoped to its course and requirement. */
  dueRetests?: ReadonlyArray<RetestEvidenceIdentity>;
  /** Server-owned identity, timing, help, and version facts for each observation. */
  evidenceContexts?: Readonly<Record<string, ObservationEligibilityInput>>;
};

export type QualifiedLearningSummary = LearningSummary & {
  courseId: string;
  requirementKey: string | null;
  evidenceEligibility: Array<{ observationId: string; eligibility: EvidenceEligibility; versionApplicability?: EvidenceVersionApplicability }>;
};

/** Captured facts remain visible even when their current applicability is unknown. */
export function summarizeObservations(
  observations: ReadonlyArray<LearningObservation>,
  _now: string,
  opts: SummarizeOptions = {},
): QualifiedLearningSummary[] {
  const groups = new Map<string, LearningObservation[]>();
  for (const row of observations) {
    const requirementKey = opts.evidenceContexts?.[row.id]?.observation.requirementKey ?? null;
    const key = JSON.stringify([row.workspaceId, row.courseId, requirementKey, row.skillLabel]);
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }

  return [...groups.values()].map((rows): QualifiedLearningSummary => {
    const first = rows[0]!;
    const requirementKey = opts.evidenceContexts?.[first.id]?.observation.requirementKey ?? null;
    const due = opts.dueRetests?.some((entry) => entry.courseId === first.courseId && entry.requirementKey === requirementKey && entry.skillLabel === first.skillLabel);
    const evidenceEligibility = rows.map((row) => {
      const input = opts.evidenceContexts?.[row.id];
      // Legacy facts are not upgraded using today's mutable problem or source.
      const observation: EvidenceObservation = input?.observation ?? {
        courseId: row.courseId,
        problemId: row.problemId,
        assistance: row.assistance,
        outcome: row.outcome,
        verdictSource: row.verdictSource,
      };
      return { observationId: row.id, eligibility: evaluateEvidenceEligibility(observation, input?.context ?? {}), versionApplicability: input?.context.version?.applicability ?? "version_unknown" };
    });
    // Revisions retain the original attempt time; recordedAt is not a new performance.
    const attemptTimes = rows.map((row) => opts.evidenceContexts?.[row.id]?.observation.submittedAt
      ?? Date.parse(row.submittedAt ?? row.occurredAt));
    const latestTime = attemptTimes.reduce((latest, time) => Math.max(latest, time), -Infinity);
    const latest = evidenceEligibility.filter((_, index) => attemptTimes[index] === latestTime);
    // A display label alone cannot establish compatibility between unknown requirements.
    const relevant = requirementKey ? latest : evidenceEligibility;
    const independent = relevant.length > 0 && relevant.every(({ eligibility }) =>
      eligibility.independentAttempt === "yes" &&
      eligibility.verifiedCorrect === "yes" &&
      eligibility.usableForCurrentVersion === "yes",
    );
    const performanceStatus = independent ? "observed_independent" : "needs_check";
    return {
      courseId: first.courseId,
      requirementKey,
      skillLabel: first.skillLabel,
      status: due ? "needs_review" : performanceStatus,
      ...(requirementKey ? { recentPerformance: { status: performanceStatus, evidenceIds: latest.map(({ observationId }) => observationId) } } : {}),
      historicalIncorrectCount: evidenceEligibility.filter(({ eligibility }, index) => attemptTimes[index]! < latestTime && eligibility.verifiedCorrect === "no").length,
      unverifiedCount: evidenceEligibility.filter(({ eligibility }) => eligibility.verifiedCorrect === "unknown").length,
      evidenceIds: rows.map((row) => row.id),
      evidenceSources: [...new Set(rows.map((row) => row.verdictSource))],
      evidenceEligibility,
      sampleCount: rows.length,
      lastObservedAt: rows.map((row) => row.occurredAt).sort().at(-1) ?? null,
    };
  }).sort((a, b) => a.courseId.localeCompare(b.courseId) || a.skillLabel.localeCompare(b.skillLabel) || (a.requirementKey ?? "").localeCompare(b.requirementKey ?? ""));
}
