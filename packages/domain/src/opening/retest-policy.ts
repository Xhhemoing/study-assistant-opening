import type { LearningSummary, RetestCandidate } from "@aistudy/contracts";

/** Default retest delay — heuristic only, not FSRS/BKT. */
export const DEFAULT_RETEST_DELAY_DAYS = 2;

/** Small candidate batch cap for L02. */
export const DEFAULT_RETEST_BATCH_LIMIT = 1;

const DAY_MS = 86_400_000;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function newCandidateId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = character === "x" ? value : (value & 3) | 8;
    return nibble.toString(16);
  });
}

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
  const ms = base + delayDays * DAY_MS;
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
  const nowMs = Date.parse(input.now);
  const eligible = input.summaries
    .filter((summary) => summary.status === "needs_check" || summary.status === "needs_review")
    .map((summary) => {
      const occurredAt = summary.lastObservedAt ?? input.now;
      const ageMs = nowMs - Date.parse(occurredAt);
      const elapsedMs = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
      // Review gaps have half the base half-life. The common base cancels
      // when comparing elapsed half-lives, even for sub-millisecond delays.
      const weightedElapsedMs = elapsedMs * (summary.status === "needs_review" ? 2 : 1);
      return { summary, occurredAt, weightedElapsedMs };
    })
    .sort((a, b) => b.weightedElapsedMs - a.weightedElapsedMs
      || compareText(a.summary.skillLabel, b.summary.skillLabel)
      || compareText(a.occurredAt, b.occurredAt));

  const out: RetestCandidate[] = [];
  for (const { summary, occurredAt } of eligible) {
    if (out.length >= limit) break;
    const sourceIds = input.sourceIdsBySkill[summary.skillLabel] ?? [];
    const prompt = input.promptsBySkill[summary.skillLabel];
    if (!sourceIds.length || !prompt) continue;
    out.push({
      id: newCandidateId(),
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
