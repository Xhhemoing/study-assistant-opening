import type { ReviewGrade } from "@aistudy/contracts";
import type { ReviewQueueItem } from "../../lib/data/types";

export type ReviewSessionStatus = "active" | "finished";

export interface ReviewSessionState {
  queue: ReviewQueueItem[];
  index: number;
  current: ReviewQueueItem | null;
  completed: number;
  flipped: boolean;
  status: ReviewSessionStatus;
}

export function createReviewSessionState(
  queue: ReviewQueueItem[],
  requestedCardId?: string,
): ReviewSessionState {
  const ordered = queue.slice();
  const requestedIndex = requestedCardId
    ? ordered.findIndex((item) => item.card.id === requestedCardId)
    : -1;
  if (requestedIndex > 0) {
    const [requested] = ordered.splice(requestedIndex, 1);
    if (requested) ordered.unshift(requested);
  }
  return {
    queue: ordered,
    index: 0,
    current: ordered[0] ?? null,
    completed: 0,
    flipped: false,
    status: ordered.length > 0 ? "active" : "finished",
  };
}

export function flipReviewCard(state: ReviewSessionState): ReviewSessionState {
  if (state.status !== "active" || !state.current) return state;
  return { ...state, flipped: !state.flipped };
}

export function applyReviewGrade(
  state: ReviewSessionState,
  _grade: ReviewGrade,
): ReviewSessionState {
  if (state.status !== "active" || !state.current) return state;
  const completed = state.completed + 1;
  const index = state.index + 1;
  const current = state.queue[index] ?? null;
  return {
    ...state,
    index,
    current,
    completed,
    flipped: false,
    status: current ? "active" : "finished",
  };
}

export function getReviewProgress(state: ReviewSessionState): {
  completed: number;
  current: number;
  total: number;
} {
  return {
    completed: state.completed,
    current: Math.min(state.completed + (state.current ? 1 : 0), state.queue.length),
    total: state.queue.length,
  };
}

export function reviewGradeForKey(key: string): ReviewGrade | null {
  const grades: Record<string, ReviewGrade> = {
    "1": "again",
    "2": "hard",
    "3": "good",
    "4": "easy",
  };
  return grades[key] ?? null;
}
