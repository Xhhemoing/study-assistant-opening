import type { ReviewGrade, ReviewState } from "@aistudy/contracts";
import { resolveLocalDayBounds, resolveWorkspaceTimeZone } from "../opening/local-day-bounds";
import { createEmptyCard, fsrs, Rating, type Card, type Grade } from "ts-fsrs";

export const SRS_VERSION = "fsrs-5.4.2";
const DAY_MS = 86_400_000;
const engine = fsrs({ request_retention: 0.9, enable_fuzz: false });
const ratings: Record<ReviewGrade, Grade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
export type ReviewDeadline = { targetDate: string | null; learningMode?: "auto" | "understand" | "exam"; today: string; timeZone?: string };

function serialize(card: Card): NonNullable<ReviewState["fsrs"]> {
  return { stability: card.stability, difficulty: card.difficulty, elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days, learningSteps: card.learning_steps, reps: card.reps, lapses: card.lapses,
    state: card.state, lastReview: card.last_review?.toISOString() ?? null };
}

export function createInitialState(cardId: string, now: Date): ReviewState {
  return { cardId, ease: 2.5, intervalDays: 0, dueAt: now.toISOString(), reps: 0, lapses: 0,
    lastGrade: null, updatedAt: now.toISOString(), srsVersion: SRS_VERSION, fsrs: serialize(createEmptyCard(now)) };
}

/** Legacy ease is retained for old readers; it is never used to invent FSRS memory strength. */
export function scheduleReview(state: ReviewState, grade: ReviewGrade, now: Date, deadline?: ReviewDeadline): ReviewState {
  const saved = state.srsVersion === SRS_VERSION ? state.fsrs : null;
  const card: Card = saved ? { due: new Date(state.dueAt), stability: saved.stability, difficulty: saved.difficulty,
    elapsed_days: saved.elapsedDays, scheduled_days: saved.scheduledDays, learning_steps: saved.learningSteps,
    reps: saved.reps, lapses: saved.lapses, state: saved.state,
    ...(saved.lastReview ? { last_review: new Date(saved.lastReview) } : {}) } : createEmptyCard(now);
  if (card.last_review && now.getTime() < card.last_review.getTime()) throw new RangeError("Review predates the last review");
  const next = engine.next(card, now, ratings[grade]).card;
  let due = next.due.getTime();
  if (deadline?.targetDate && deadline.learningMode !== "understand") {
    // Date-only exams are bounded by the start of that local day, not 24h after the current clock.
    // Today/past or a final <2 minute window cannot support another useful pre-exam review.
    if (deadline.targetDate > deadline.today) {
      const remaining = resolveLocalDayBounds(deadline.targetDate, resolveWorkspaceTimeZone(deadline.timeZone)).dayStart.getTime() - now.getTime();
      if (remaining >= 120_000) due = Math.min(due, now.getTime() + Math.floor(remaining / 2));
    }
  }
  next.due = new Date(due);
  return { ...state, intervalDays: Math.floor((due - now.getTime()) / DAY_MS), dueAt: next.due.toISOString(),
    reps: state.reps + 1, lapses: state.lapses + (grade === "again" ? 1 : 0), lastGrade: grade,
    updatedAt: now.toISOString(), srsVersion: SRS_VERSION, fsrs: serialize(next) };
}

/** Replay only complete, valid history. Reading an old card alone never changes its due date. */
export function migrateReviewHistory(state: ReviewState, history: Array<{ grade: ReviewGrade; occurredAt: string }>): ReviewState {
  if (state.srsVersion === SRS_VERSION && state.fsrs || history.length === 0 || history.length !== state.reps) return state;
  const ordered = [...history].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  if (ordered.some(row => !Number.isFinite(Date.parse(row.occurredAt)) || !(row.grade in ratings))) return state;
  let replay = createInitialState(state.cardId, new Date(ordered[0]!.occurredAt));
  for (const event of ordered) replay = scheduleReview(replay, event.grade, new Date(event.occurredAt));
  return { ...state, srsVersion: SRS_VERSION, fsrs: replay.fsrs };
}
