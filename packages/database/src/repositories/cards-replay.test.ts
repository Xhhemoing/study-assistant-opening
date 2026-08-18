import { describe, expect, it } from "vitest";
import type { LearningEvent } from "@aistudy/contracts";
import { assertReplayableReviewEvent } from "./cards-replay";
import { CardRepositoryError } from "./cards-types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const cardId = "33333333-3333-4333-8333-333333333333";
const otherCardId = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-15T03:00:00.000Z";

function reviewEvent(overrides: Partial<LearningEvent> = {}): LearningEvent {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    workspaceId,
    ownerUserId,
    type: "review",
    schemaVersion: 1,
    idempotencyKey: "review-key-01",
    occurredAt: now,
    createdAt: now,
    contentId: cardId,
    contentVersion: 1,
    syllabusPointId: null,
    correctsEventId: null,
    payload: { grade: "good", assisted: false, excludeFromAssessment: false },
    ...overrides,
  } as LearningEvent;
}

describe("review replay guard", () => {
  it("accepts a replay of the same review on the same card", () => {
    expect(() => assertReplayableReviewEvent(reviewEvent(), cardId)).not.toThrow();
  });

  it("rejects a key already used by another event type", () => {
    const attempt = reviewEvent({
      type: "attempt",
      syllabusPointId: "66666666-6666-4666-8666-666666666666",
      payload: {
        answer: "A",
        correct: true,
        assisted: false,
        durationMs: 1000,
        hintCount: 0,
        confidence: 3,
        errorCause: null,
        abilitySlice: "procedure",
      },
    } as Partial<LearningEvent>);
    expect(() => assertReplayableReviewEvent(attempt, cardId)).toThrowError(CardRepositoryError);
    try {
      assertReplayableReviewEvent(attempt, cardId);
    } catch (error) {
      expect((error as CardRepositoryError).code).toBe("CONFLICT");
    }
  });

  it("rejects a key already used by a review of another card", () => {
    const foreign = reviewEvent({ contentId: otherCardId });
    try {
      assertReplayableReviewEvent(foreign, cardId);
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(CardRepositoryError);
      expect((error as CardRepositoryError).code).toBe("CONFLICT");
    }
  });
});
