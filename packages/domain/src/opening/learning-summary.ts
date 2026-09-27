import type { LearningObservation, LearningSummary } from "@aistudy/contracts";

export type SummarizeOptions = {
  /** Skills with an accepted due retest → needs_review (L02). */
  dueRetestSkillLabels?: ReadonlySet<string>;
  /** Server-known current versions. Client source ids are not trusted alone. */
  currentSourceVersions?: Readonly<Record<string, number>>;
  /** Observation id → source id → version recorded with that evidence. */
  observationSourceVersions?: Readonly<Record<string, Readonly<Record<string, number>>>>;
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
    const usable = rows.filter((row) => !isStaleSourceEvidence(row, opts));
    if (usable.length === 0) continue;
    const evidenceIds = usable.map((r) => r.id);
    const lastObservedAt =
      usable
        .map((r) => r.occurredAt)
        .sort()
        .at(-1) ?? null;

    let status: LearningSummary["status"] = "needs_check";

    if (due.has(skillLabel)) {
      status = "needs_review";
    } else if (usable.every((row) => isObservedIndependentEvidence(row, opts))) {
      status = "observed_independent";
    } else {
      status = "needs_check";
    }

    summaries.push({
      skillLabel,
      status,
      evidenceIds,
      evidenceSources: [...new Set(usable.map((row) => row.verdictSource))],
      sampleCount: usable.length,
      lastObservedAt,
    });
  }

  return summaries.sort((a, b) => a.skillLabel.localeCompare(b.skillLabel));
}

function isObservedIndependentEvidence(
  row: LearningObservation,
  opts: SummarizeOptions,
): boolean {
  if (
    row.assistance !== "independent" ||
    row.outcome !== "correct" ||
    row.verdictSource !== "reference_checked" ||
    !row.referenceSourceId
  ) {
    return false;
  }
  return sourceVersionMatches(row, row.referenceSourceId, opts);
}

function isStaleSourceEvidence(
  row: LearningObservation,
  opts: SummarizeOptions,
): boolean {
  const current = opts.currentSourceVersions;
  const recorded = opts.observationSourceVersions?.[row.id];
  if (!current || !recorded) return false;
  const ids = new Set([...(row.sourceIds ?? []), row.referenceSourceId].filter(Boolean) as string[]);
  for (const id of ids) {
    if (current[id] === undefined || recorded[id] === undefined) continue;
    if (recorded[id] !== current[id]) return true;
  }
  return false;
}

function sourceVersionMatches(
  row: LearningObservation,
  sourceId: string,
  opts: SummarizeOptions,
): boolean {
  const current = opts.currentSourceVersions?.[sourceId];
  const recorded = opts.observationSourceVersions?.[row.id]?.[sourceId];
  if (current === undefined && recorded === undefined) return true;
  return current !== undefined && recorded === current;
}
