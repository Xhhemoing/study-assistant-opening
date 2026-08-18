import { describe, expect, it } from "vitest";
import type { LearningEvent } from "@aistudy/contracts";
import { learningEventToAttempt } from "./attempt-service";

const now = "2026-08-15T03:30:00.000Z";
const practiceItemId = "44444444-4444-4444-8444-444444444444";

const attemptEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  ownerUserId: "33333333-3333-4333-8333-333333333333",
  type: "attempt" as const,
  schemaVersion: 1,
  idempotencyKey: "attempt-key-01",
  occurredAt: now,
  createdAt: now,
  contentId: practiceItemId,
  contentVersion: 2,
  syllabusPointId: "55555555-5555-4555-8555-555555555555",
  correctsEventId: null,
  payload: {
    answer: "A",
    correct: true,
    assisted: true,
    durationMs: 15000,
    hintCount: 1,
    confidence: 2,
    errorCause: null,
    abilitySlice: "procedure" as const,
  },
} satisfies LearningEvent;

describe("submitAttemptRequestSchema at the service boundary", () => {
  it("rejects forged correctness before a learning event can be appended", async () => {
    const { submitAttemptForPrincipal } = await import("./attempt-service");
    await expect(
      submitAttemptForPrincipal(
        {} as never,
        { userId: attemptEvent.ownerUserId, workspaceId: attemptEvent.workspaceId } as never,
        {
          practiceSessionId: practiceItemId,
          answer: "wrong",
          confidence: 5,
          errorCause: null,
          idempotencyKey: "attempt-0001",
          correct: true,
          syllabusPointId: attemptEvent.syllabusPointId,
          abilitySlice: "transfer",
        },
      ),
    ).rejects.toThrow();
  });
});

describe("learningEventToAttempt", () => {
  it("maps an append-only attempt event onto the practice attempt contract", () => {
    const event = learningEventToAttempt(attemptEvent, practiceItemId);
    expect(event).toMatchObject({
      id: attemptEvent.id,
      ownerUserId: attemptEvent.ownerUserId,
      practiceItemId,
      syllabusPointId: attemptEvent.syllabusPointId,
      idempotencyKey: "attempt-key-01",
      answer: "A",
      correct: true,
      assisted: true,
      durationMs: 15000,
      hintCount: 1,
      confidence: 2,
      contentVersion: 2,
      schemaVersion: 1,
    });
  });

  it("rejects non-attempt learning events", () => {
    expect(() =>
      learningEventToAttempt(
        {
          ...attemptEvent,
          type: "review",
          payload: { grade: "good", assisted: false, excludeFromAssessment: false },
        },
        practiceItemId,
      ),
    ).toThrow(/attempt/i);
  });
});
