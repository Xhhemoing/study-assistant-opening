import { randomUUID } from "node:crypto";
import type { LearningSummary, RetestCandidate } from "@aistudy/contracts";

/** Default retest delay — heuristic only, not FSRS/BKT. */
export const DEFAULT_RETEST_DELAY_DAYS = 2;

/** Small candidate batch cap for L02. */
export const DEFAULT_RETEST_BATCH_LIMIT = 1;

/**
 * Add delayDays to an ISO timestamp (UTC). Editable heuristic — not a retention model.
 */
export function suggestRetestAt(occurredAt: string, delayDays: number): string {
  const base = Date.parse(occurredAt);
  if (!Number.isFinite(base)) {
    throw new Error(`invalid occurredAt: ${occurredAt}`);
  }
  if (!Number.isFinite(delayDays) || delayDays < 0) {
    throw new Error(`invalid delayDays: ${delayDays}`);
  }
  const ms = base + delayDays * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

export type BuildRetestCandidatesInput = {
  courseId: string;
  summaries: ReadonlyArray<LearningSummary>;
  now: string;
  sourceIdsBySkill: Readonly<Record<string, string[]>>;
  promptsBySkill: Readonly<Record<string, string>>;
  delayDays?: number;
  limit?: number;
};

/**
 * Skills that still need practice become proposals (not formal tasks until accept).
 * observed_independent is skipped; missing source refs are skipped (no invented stems).
 */
export function buildRetestCandidates(
  input: BuildRetestCandidatesInput,
): RetestCandidate[] {
  const delayDays = input.delayDays ?? DEFAULT_RETEST_DELAY_DAYS;
  const limit = input.limit ?? DEFAULT_RETEST_BATCH_LIMIT;
  const eligible = input.summaries.filter(
    (s) => s.status === "needs_check" || s.status === "needs_review",
  );

  const out: RetestCandidate[] = [];
  for (const summary of eligible) {
    if (out.length >= limit) break;
    const sourceIds = input.sourceIdsBySkill[summary.skillLabel] ?? [];
    const prompt = input.promptsBySkill[summary.skillLabel];
    if (!sourceIds.length || !prompt) continue;
    const occurredAt = summary.lastObservedAt ?? input.now;
    out.push({
      id: randomUUID(),
      courseId: input.courseId,
      skillLabel: summary.skillLabel,
      prompt,
      sourceIds,
      dueAt: suggestRetestAt(occurredAt, delayDays),
      accepted: false,
    });
  }
  return out;
}
