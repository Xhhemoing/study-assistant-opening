import type { ReviewGrade, ReviewState } from "@aistudy/contracts";
import { resolveLocalDayBounds, resolveWorkspaceTimeZone } from "../opening/local-day-bounds";
import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from "ts-fsrs";

export const SRS_VERSION = "fsrs-5.4.2";
export const PERSONAL_FSRS_MIN_REVIEWS = 400;
const DAY_MS = 86_400_000;
const engine = fsrs({ request_retention: 0.9, enable_fuzz: false });
const ratings: Record<ReviewGrade, Grade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
export type ReviewDeadline = { targetDate: string | null; learningMode?: "auto" | "understand" | "exam"; today: string; timeZone?: string };

export type CardRetrievabilityResult =
  | {
      retrievabilityStatus: "known";
      retrievability: number;
      elapsedDaysSinceLastReview: number;
    }
  | {
      retrievabilityStatus: "unseen_or_unknown";
      retrievability: null;
      elapsedDaysSinceLastReview: null;
    };

export type CardMasteryEvidenceDecision = {
  countsTowardSkillBelief: boolean;
  canonicalObservationId: string | null;
};

/**
 * Evaluates true FSRS-6.0 retrievability strictly from persisted FSRS memory state
 * (`lastReview` and `stability`), never from `dueAt`, `intervalDays`, or `updatedAt`
 * because pre-exam compression can pull `dueAt` far earlier than natural forgetting.
 */
export function computeCardRetrievability(state: ReviewState, now: Date): CardRetrievabilityResult {
  const nowMs = now.getTime();
  const saved = state.srsVersion === SRS_VERSION ? state.fsrs : null;
  if (
    !(state.reps > 0)
    || !saved
    || saved.state === State.New
    || saved.lastReview == null
    || !Number.isFinite(nowMs)
  ) {
    return {
      retrievabilityStatus: "unseen_or_unknown",
      retrievability: null,
      elapsedDaysSinceLastReview: null,
    };
  }
  const lastReviewMs = Date.parse(saved.lastReview);
  if (!Number.isFinite(lastReviewMs) || !Number.isFinite(saved.stability) || !(saved.stability > 0)) {
    return {
      retrievabilityStatus: "unseen_or_unknown",
      retrievability: null,
      elapsedDaysSinceLastReview: null,
    };
  }
  const elapsedDays = Math.max(0, (nowMs - lastReviewMs) / DAY_MS);
  const clampedNow = new Date(Math.max(nowMs, lastReviewMs));
  const dueMs = Date.parse(state.dueAt);
  const card: Card = {
    due: Number.isFinite(dueMs) ? new Date(dueMs) : clampedNow,
    stability: saved.stability,
    difficulty: saved.difficulty,
    elapsed_days: saved.elapsedDays,
    scheduled_days: saved.scheduledDays,
    learning_steps: saved.learningSteps,
    reps: saved.reps,
    lapses: saved.lapses,
    state: saved.state,
    last_review: new Date(lastReviewMs),
  };
  const retrievability = engine.get_retrievability(card, clampedNow, false);
  if (!Number.isFinite(retrievability)) {
    return {
      retrievabilityStatus: "unseen_or_unknown",
      retrievability: null,
      elapsedDaysSinceLastReview: null,
    };
  }
  return {
    retrievabilityStatus: "known",
    retrievability,
    elapsedDaysSinceLastReview: elapsedDays,
  };
}

/** Personal FSRS weight fitting remains locked to default weights below 400 independent reviews. */
export function canFitPersonalFsrsParameters(deduplicatedIndependentReviewCount: number): boolean {
  return (
    Number.isFinite(deduplicatedIndependentReviewCount)
    && deduplicatedIndependentReviewCount >= PERSONAL_FSRS_MIN_REVIEWS
  );
}

/**
 * Plain flashcard self-ratings advance FSRS only and never enter SkillBeliefV1;
 * variant-backed reviews count only once per canonical `variantObservationId`.
 */
export function isIndependentCardMasteryEvidence(
  meta: { variantObservationId?: string | null },
): CardMasteryEvidenceDecision {
  const observationId = typeof meta.variantObservationId === "string"
    ? meta.variantObservationId.trim()
    : "";
  if (!observationId) {
    return { countsTowardSkillBelief: false, canonicalObservationId: null };
  }
  return { countsTowardSkillBelief: true, canonicalObservationId: observationId };
}

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
