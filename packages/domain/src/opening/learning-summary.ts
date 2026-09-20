import type { LearningObservation, LearningSummary } from "@aistudy/contracts";

export type SummarizeOptions = {
  /** Skills with an accepted due retest → needs_review (L02). */
  dueRetestSkillLabels?: ReadonlySet<string>;
};

/**
 * Explainable learning state from L01 observations.
 * Empty evidence → empty summary (never invent mastery).
 * Labels are limited observed evidence — not calibrated mastery.
 */
export function summarizeObservations(
  observations: ReadonlyArray<LearningObservation>,
  _now: string,
  opts: SummarizeOptions = {},
): LearningSummary[] {
  if (observations.length === 0) return [];

  const bySkill = new Map<string, LearningObservation[]>();
  for (const row of observations) {
    const list = bySkill.get(row.skillLabel) ?? [];
    list.push(row);
    bySkill.set(row.skillLabel, list);
  }

  const due = opts.dueRetestSkillLabels ?? new Set<string>();
  const summaries: LearningSummary[] = [];

  for (const [skillLabel, rows] of bySkill) {
    const evidenceIds = rows.map((r) => r.id);
    const lastObservedAt =
      rows
        .map((r) => r.occurredAt)
        .sort()
        .at(-1) ?? null;

    let status: LearningSummary["status"] = "needs_check";

    if (due.has(skillLabel)) {
      status = "needs_review";
    } else if (rows.every(isObservedIndependentEvidence)) {
      status = "observed_independent";
    } else {
      status = "needs_check";
    }

    summaries.push({
      skillLabel,
      status,
      evidenceIds,
      sampleCount: rows.length,
      lastObservedAt,
    });
  }

  return summaries.sort((a, b) => a.skillLabel.localeCompare(b.skillLabel));
}

function isObservedIndependentEvidence(row: LearningObservation): boolean {
  return (
    row.assistance === "independent" &&
    row.outcome === "correct" &&
    row.verdictSource === "reference_checked"
  );
}
