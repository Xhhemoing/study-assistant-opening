import { describe, expect, it } from "vitest";
import {
  createCardRequestSchema,
  gradeReviewRequestSchema,
  gradeReviewResponseSchema,
  listReviewQueueQuerySchema,
  listReviewQueueResponseSchema,
  updateCardControlsRequestSchema,
} from "./reviews";

const cardId = "44444444-4444-4444-8444-444444444444";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-15T12:00:00.000Z";

describe("review HTTP contracts", () => {
  it("requires a stable idempotency key before a review can be graded", () => {
    const body = { cardId, grade: "good" as const };
    expect(gradeReviewRequestSchema.parse({ ...body, idempotencyKey: "review-key-01" }).idempotencyKey).toBe(
      "review-key-01",
    );
    expect(gradeReviewRequestSchema.parse({ ...body, idempotencyKey: "review-key-01" }).assisted).toBe(false);
    expect(() => gradeReviewRequestSchema.parse({ ...body, idempotencyKey: "short" })).toThrow();
  });

  it("parses a grade response that keeps review state separate from the learning event", () => {
    const parsed = gradeReviewResponseSchema.parse({
      state: {
        cardId,
        ease: 2.5,
        intervalDays: 1,
        dueAt: now,
        reps: 1,
        lapses: 0,
        lastGrade: "good",
        updatedAt: now,
      },
      event: {
        id: "55555555-5555-4555-8555-555555555555",
        workspaceId: "22222222-2222-4222-8222-222222222222",
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
        payload: { grade: "good", assisted: false, excludeFromAssessment: true },
      },
    });
    expect(parsed.event.type).toBe("review");
    expect(parsed.state.reps).toBe(1);
    expect(parsed.event.payload).toEqual({
      grade: "good",
      assisted: false,
      excludeFromAssessment: true,
    });
  });

  it("defaults list mode to auto and rejects unknown modes", () => {
    expect(listReviewQueueQuerySchema.parse({}).mode).toBe("auto");
    expect(listReviewQueueQuerySchema.parse({ mode: "self-selected" }).mode).toBe("self-selected");
    expect(() => listReviewQueueQuerySchema.parse({ mode: "manual" })).toThrow();
  });

  it("parses a queue response and a create-card request", () => {
    expect(
      createCardRequestSchema.parse({
        cardId,
        front: "导数",
        back: "极限定义",
        tags: ["高数"],
      }).front,
    ).toBe("导数");
    expect(() => createCardRequestSchema.parse({ front: "", back: "x" })).toThrow();

    const queue = listReviewQueueResponseSchema.parse({
      items: [
        {
          card: {
            id: cardId,
            ownerUserId,
            front: "导数",
            back: "极限定义",
            sourceDocumentId: null,
            syllabusPointId: null,
            tags: ["高数"],
            archived: false,
            createdAt: now,
          },
          state: {
            cardId,
            ease: 2.5,
            intervalDays: 0,
            dueAt: now,
            reps: 0,
            lapses: 0,
            lastGrade: null,
            updatedAt: now,
          },
          goalPriority: 4,
        },
      ],
    });
    expect(queue.items[0]?.goalPriority).toBe(4);
    expect(queue.items[0]?.card.contentVersion).toBe(1);
  });

  it("requires a card id and at least one control field before updating card controls", () => {
    expect(
      updateCardControlsRequestSchema.parse({
        cardId,
        archived: true,
        pausedUntil: null,
        maintainUntil: "2026-12-31",
        excludeFromAssessment: true,
      }).maintainUntil,
    ).toBe("2026-12-31");
    expect(() => updateCardControlsRequestSchema.parse({ cardId })).toThrow();
    expect(() =>
      updateCardControlsRequestSchema.parse({ cardId, maintainUntil: "2026/12/31" }),
    ).toThrow();
  });
});
