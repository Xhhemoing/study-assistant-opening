import type { ReviewGrade, ReviewState } from "@aistudy/contracts";

export const SRS_VERSION = "srs-1";
const MIN_EASE = 1.3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createInitialState(cardId: string, now: Date): ReviewState {
  return {
    cardId,
    ease: 2.5,
    intervalDays: 0,
    dueAt: now.toISOString(),
    reps: 0,
    lapses: 0,
    lastGrade: null,
    updatedAt: now.toISOString(),
  };
}

export function scheduleReview(state: ReviewState, grade: ReviewGrade, now: Date): ReviewState {
  let ease = state.ease;
  let intervalDays = state.intervalDays;
  let dueInMs: number;
  const lapses = state.lapses + (grade === "again" ? 1 : 0);
  if (grade === "again") {
    ease = Math.max(MIN_EASE, ease - 0.2);
    intervalDays = 0;
    dueInMs = 10 * 60 * 1000;
  } else if (grade === "hard") {
    ease = Math.max(MIN_EASE, ease - 0.15);
    intervalDays = intervalDays < 1 ? 1 : Math.round(intervalDays * 1.2);
    dueInMs = intervalDays * DAY_MS;
  } else if (grade === "good") {
    intervalDays = intervalDays < 1 ? 1 : Math.round(intervalDays * ease);
    dueInMs = intervalDays * DAY_MS;
  } else {
    ease += 0.15;
    intervalDays = intervalDays < 1 ? 3 : Math.round(intervalDays * ease * 1.3);
    dueInMs = intervalDays * DAY_MS;
  }
  return {
    cardId: state.cardId,
    ease: Number(ease.toFixed(2)),
    intervalDays,
    dueAt: new Date(now.getTime() + dueInMs).toISOString(),
    reps: state.reps + 1,
    lapses,
    lastGrade: grade,
    updatedAt: now.toISOString(),
  };
}
