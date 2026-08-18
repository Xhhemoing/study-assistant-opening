import { describe, expect, it } from "vitest";
import {
  appendLearningEventInputSchema,
  learningEventSchema,
  reviewLearningPayloadSchema,
} from "./learning-events";

const id = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "33333333-3333-4333-8333-333333333333";
const contentId = "44444444-4444-4444-8444-444444444444";
const syllabusPointId = "55555555-5555-4555-8555-555555555555";
const now = "2026-08-15T03:00:00.000Z";

const attemptEnvelope = {
  id,
  workspaceId,
  ownerUserId,
  type: "attempt" as const,
  schemaVersion: 1,
  idempotencyKey: "attempt-key-01",
  occurredAt: now,
  createdAt: now,
  contentId,
  contentVersion: 3,
  syllabusPointId,
  correctsEventId: null,
  payload: {
    answer: "A",
    correct: false,
    assisted: false,
    durationMs: 14000,
    hintCount: 1,
    confidence: 2,
    errorCause: "concept",
    abilitySlice: "procedure",
  },
};

describe("learning event contracts", () => {
  it("parses a typed attempt envelope with schema and content versions", () => {
    const parsed = learningEventSchema.parse(attemptEnvelope);
    expect(parsed.type).toBe("attempt");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.contentVersion).toBe(3);
    expect(parsed.payload.errorCause).toBe("concept");
  });

  it("rejects an untyped JSON-only payload", () => {
    expect(() =>
      learningEventSchema.parse({
        ...attemptEnvelope,
        payload: { note: "free-form blob" },
      }),
    ).toThrow();
  });

  it("requires an idempotency key of at least 8 characters", () => {
    expect(() =>
      learningEventSchema.parse({ ...attemptEnvelope, idempotencyKey: "short" }),
    ).toThrow();
  });

  it("parses a correction that points at the original event id", () => {
    const parsed = learningEventSchema.parse({
      ...attemptEnvelope,
      id: "66666666-6666-4666-8666-666666666666",
      type: "correction",
      idempotencyKey: "correct-key-01",
      contentId: null,
      contentVersion: null,
      syllabusPointId: null,
      correctsEventId: id,
      payload: { kind: "error_cause", note: "错因应改为计算", overrideErrorCause: "calculation" },
    });
    expect(parsed.type).toBe("correction");
    expect(parsed.correctsEventId).toBe(id);
    expect(parsed.payload.kind).toBe("error_cause");
  });

  it("rejects a correction without correctsEventId", () => {
    expect(() =>
      learningEventSchema.parse({
        ...attemptEnvelope,
        type: "correction",
        correctsEventId: null,
        payload: { kind: "status", note: "状态不准" },
      }),
    ).toThrow();
  });

  it("parses a review envelope that keeps the card content version", () => {
    const parsed = learningEventSchema.parse({
      ...attemptEnvelope,
      type: "review",
      idempotencyKey: "review-key-01",
      payload: { grade: "good", assisted: false },
    });
    expect(parsed.type).toBe("review");
    expect(parsed.contentVersion).toBe(3);
    expect(parsed.payload.grade).toBe("good");
  });

  it("defaults review excludeFromAssessment to false without touching assisted", () => {
    const parsed = reviewLearningPayloadSchema.parse({ grade: "good", assisted: true });
    expect(parsed.assisted).toBe(true);
    expect(parsed.excludeFromAssessment).toBe(false);
  });

  it("keeps review assisted and excludeFromAssessment independent", () => {
    const excludedOnly = reviewLearningPayloadSchema.parse({
      grade: "hard",
      assisted: false,
      excludeFromAssessment: true,
    });
    expect(excludedOnly.assisted).toBe(false);
    expect(excludedOnly.excludeFromAssessment).toBe(true);

    const assistedOnly = reviewLearningPayloadSchema.parse({
      grade: "again",
      assisted: true,
      excludeFromAssessment: false,
    });
    expect(assistedOnly.assisted).toBe(true);
    expect(assistedOnly.excludeFromAssessment).toBe(false);

    expect(() =>
      reviewLearningPayloadSchema.parse({
        grade: "good",
        assisted: false,
        excludeFromAssessment: "yes",
      }),
    ).toThrow();
  });

  it("carries an excluded review through the full event envelope", () => {
    const parsed = learningEventSchema.parse({
      ...attemptEnvelope,
      type: "review",
      idempotencyKey: "review-key-02",
      payload: { grade: "good", assisted: false, excludeFromAssessment: true },
    });
    expect(parsed.payload).toEqual({
      grade: "good",
      assisted: false,
      excludeFromAssessment: true,
    });
  });

  it("accepts append input without a client-supplied event id", () => {
    const parsed = appendLearningEventInputSchema.parse({
      workspaceId,
      ownerUserId,
      type: "attempt",
      idempotencyKey: "attempt-key-01",
      occurredAt: now,
      contentId,
      contentVersion: 3,
      syllabusPointId,
      payload: attemptEnvelope.payload,
    });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.correctsEventId).toBeNull();
  });
});
