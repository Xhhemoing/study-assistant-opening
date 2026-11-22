import { portableFsrsSnapshotSchema, type PortableFsrsSnapshot } from "@aistudy/contracts/learner-portability";
import { createEmptyCard, fsrs, Rating, type Card } from "ts-fsrs";

const engine = fsrs({ request_retention: 0.9, enable_fuzz: false });
const ratings = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy } as const;
export type PortableReviewGrade = keyof typeof ratings;

function snapshot(cardId: string, card: Card): PortableFsrsSnapshot {
  return portableFsrsSnapshotSchema.parse({
    version: "fsrs-5.4.2", cardId, dueAt: card.due.toISOString(), lastReviewAt: card.last_review?.toISOString() ?? null,
    stability: card.stability, difficulty: card.difficulty, elapsedDays: card.elapsed_days, scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps, reps: card.reps, lapses: card.lapses, state: card.state,
  });
}

export function createPortableReview(cardId: string, now: Date): PortableFsrsSnapshot {
  return snapshot(cardId, createEmptyCard(now));
}

export function schedulePortableReview(input: PortableFsrsSnapshot, grade: PortableReviewGrade, now: Date): PortableFsrsSnapshot {
  const saved = portableFsrsSnapshotSchema.parse(input);
  const lastReview = saved.lastReviewAt ? new Date(saved.lastReviewAt) : undefined;
  if (!Number.isFinite(now.getTime()) || (lastReview && now < lastReview)) throw new RangeError("Invalid review time");
  if (!Object.hasOwn(ratings, grade)) throw new TypeError("Invalid review grade");
  const card: Card = {
    due: new Date(saved.dueAt), stability: saved.stability, difficulty: saved.difficulty, elapsed_days: saved.elapsedDays,
    scheduled_days: saved.scheduledDays, learning_steps: saved.learningSteps, reps: saved.reps, lapses: saved.lapses, state: saved.state,
    ...(lastReview ? { last_review: lastReview } : {}),
  };
  return snapshot(saved.cardId, engine.next(card, now, ratings[grade]).card);
}
