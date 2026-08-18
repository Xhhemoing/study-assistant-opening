import type { ReviewCard, ReviewQueueMode, ReviewState } from "@aistudy/contracts";

export type ReviewQueueItem = {
  card: ReviewCard;
  state: ReviewState;
  goalPriority: number;
};

export type ReviewEligibility = {
  eligible: boolean;
  excludeFromAssessment: boolean;
};

function isPaused(card: ReviewCard, now: Date): boolean {
  if (!card.pausedUntil) return false;
  return Date.parse(card.pausedUntil) > now.getTime();
}

function isMaintainExpiredForAuto(card: ReviewCard, today: string): boolean {
  if (!card.maintainUntil) return false;
  return card.maintainUntil < today;
}

function isDue(state: ReviewState, now: Date): boolean {
  return Date.parse(state.dueAt) <= now.getTime();
}

export function reviewEligibilityForMode(
  card: ReviewCard,
  state: ReviewState,
  mode: ReviewQueueMode,
  now: Date,
  today: string,
): ReviewEligibility {
  if (card.archived || isPaused(card, now)) {
    return { eligible: false, excludeFromAssessment: card.excludeFromAssessment };
  }
  if (mode === "auto") {
    if (isMaintainExpiredForAuto(card, today) || !isDue(state, now)) {
      return { eligible: false, excludeFromAssessment: card.excludeFromAssessment };
    }
  }
  return { eligible: true, excludeFromAssessment: card.excludeFromAssessment };
}

export function isCardEligibleForMode(
  card: ReviewCard,
  state: ReviewState,
  mode: ReviewQueueMode,
  now: Date,
  today: string,
): boolean {
  return reviewEligibilityForMode(card, state, mode, now, today).eligible;
}

function compareQueueItems(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const dueCmp = a.state.dueAt.localeCompare(b.state.dueAt);
  if (dueCmp !== 0) return dueCmp;
  const priorityCmp = b.goalPriority - a.goalPriority;
  if (priorityCmp !== 0) return priorityCmp;
  return a.card.id.localeCompare(b.card.id);
}

export function buildReviewQueue(
  items: readonly ReviewQueueItem[],
  mode: ReviewQueueMode,
  now: Date,
  today: string,
): ReviewQueueItem[] {
  return items
    .filter((item) => isCardEligibleForMode(item.card, item.state, mode, now, today))
    .slice()
    .sort(compareQueueItems);
}
