import { describe, expect, it } from "vitest";
import type { ReviewQueueItem } from "../../lib/data/types";
import {
  applyReviewGrade,
  createReviewSessionState,
  flipReviewCard,
  getReviewProgress,
  resolveReviewGradeIdentity,
  reviewGradeForKey,
} from "./review-session-model";

const queue: ReviewQueueItem[] = [
  {
    card: {
      id: "66666666-6666-4666-8666-666666666601",
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      front: "卡片一正面",
      back: "卡片一背面",
      sourceDocumentId: null,
      syllabusPointId: null,
      tags: ["复习"],
      archived: false,
      contentVersion: 1,
      pausedUntil: null,
      maintainUntil: null,
      excludeFromAssessment: false,
      createdAt: "2026-08-03T08:00:00.000Z",
    },
    state: {
      cardId: "66666666-6666-4666-8666-666666666601",
      ease: 2.5,
      intervalDays: 0,
      dueAt: "2026-08-03T08:00:00.000Z",
      reps: 0,
      lapses: 0,
      lastGrade: null,
      updatedAt: "2026-08-03T08:00:00.000Z",
    },
  },
  {
    card: {
      id: "66666666-6666-4666-8666-666666666602",
      ownerUserId: "11111111-1111-4111-8111-111111111111",
      front: "卡片二正面",
      back: "卡片二背面",
      sourceDocumentId: null,
      syllabusPointId: null,
      tags: ["复习"],
      archived: false,
      contentVersion: 1,
      pausedUntil: null,
      maintainUntil: null,
      excludeFromAssessment: false,
      createdAt: "2026-08-03T08:00:00.000Z",
    },
    state: {
      cardId: "66666666-6666-4666-8666-666666666602",
      ease: 2.5,
      intervalDays: 0,
      dueAt: "2026-08-03T08:01:00.000Z",
      reps: 0,
      lapses: 0,
      lastGrade: null,
      updatedAt: "2026-08-03T08:00:00.000Z",
    },
  },
];

describe("review session model", () => {
  it("starts with the requested due card and keeps the remaining queue stable", () => {
    const state = createReviewSessionState(queue, queue[1]?.card.id);

    expect(state.queue.map((item) => item.card.id)).toEqual([
      queue[1]?.card.id,
      queue[0]?.card.id,
    ]);
    expect(state.current?.card.front).toBe("卡片二正面");
    expect(getReviewProgress(state)).toEqual({ completed: 0, current: 1, total: 2 });
  });

  it("flips the current card and resets it after grading", () => {
    const flipped = flipReviewCard(createReviewSessionState(queue));
    expect(flipped.flipped).toBe(true);

    const next = applyReviewGrade(flipped, "good");
    expect(next.flipped).toBe(false);
    expect(next.current?.card.id).toBe(queue[1]?.card.id);
    expect(next.completed).toBe(1);
    expect(next.status).toBe("active");
  });

  it("finishes after the last grade and maps numeric shortcuts", () => {
    const first = applyReviewGrade(createReviewSessionState(queue), "again");
    const finished = applyReviewGrade(first, "easy");

    expect(finished.status).toBe("finished");
    expect(finished.current).toBeNull();
    expect(getReviewProgress(finished)).toEqual({ completed: 2, current: 2, total: 2 });
    expect(reviewGradeForKey("1")).toBe("again");
    expect(reviewGradeForKey("4")).toBe("easy");
    expect(reviewGradeForKey("0")).toBeNull();
  });

  it("reuses an idempotency key for the same card and grade", () => {
    const first = resolveReviewGradeIdentity(null, queue[0]!.card.id, "good", () => "review-key-new");
    const retried = resolveReviewGradeIdentity(first, queue[0]!.card.id, "good", () => "should-not-run");
    expect(retried.key).toBe(first.key);
  });

  it("issues a new idempotency key when the card or grade changes", () => {
    let n = 0;
    const createKey = () => `review-key-${++n}`;
    const first = resolveReviewGradeIdentity(null, queue[0]!.card.id, "good", createKey);
    const changedGrade = resolveReviewGradeIdentity(first, queue[0]!.card.id, "hard", createKey);
    const changedCard = resolveReviewGradeIdentity(changedGrade, queue[1]!.card.id, "hard", createKey);
    expect(changedGrade.key).not.toBe(first.key);
    expect(changedCard.key).not.toBe(changedGrade.key);
  });
});
