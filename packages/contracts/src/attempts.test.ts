import { describe, expect, it } from "vitest";
import {
  attemptEventSchema,
  practiceItemSchema,
  submitAttemptRequestSchema,
  submitAttemptResponseSchema,
} from "./attempts";

const id = "11111111-1111-4111-8111-111111111111";
const now = "2026-08-15T03:30:00.000Z";

const item = {
  id,
  syllabusPointId: "22222222-2222-4222-8222-222222222222",
  kind: "multiple_choice" as const,
  stem: "导数的定义是什么？",
  options: ["A. 极限", "B. 积分"],
  answer: "A",
  hints: ["回到增量比"],
  abilitySlice: "recognition" as const,
  estimatedMinutes: 5,
  contentVersion: 2,
};

const attempt = {
  id,
  ownerUserId: "33333333-3333-4333-8333-333333333333",
  practiceItemId: id,
  syllabusPointId: item.syllabusPointId,
  idempotencyKey: "attempt-key-01",
  answer: "A",
  correct: true,
  assisted: false,
  durationMs: 12000,
  hintCount: 0,
  confidence: 4,
  errorCause: null,
  abilitySlice: "recognition" as const,
  contentVersion: 2,
  schemaVersion: 1,
  createdAt: now,
};

describe("attempt contracts", () => {
  it("parses multiple-choice, short-answer, and checkpoint items", () => {
    expect(practiceItemSchema.parse(item).kind).toBe("multiple_choice");
    expect(
      practiceItemSchema.parse({
        ...item,
        kind: "short_answer",
        options: undefined,
        answer: "极限",
      }).kind,
    ).toBe("short_answer");
    expect(
      practiceItemSchema.parse({
        ...item,
        kind: "checkpoint",
        options: ["列式", "跳步", "求解"],
        answer: "0,2",
      }).kind,
    ).toBe("checkpoint");
  });

  it("keeps timing, hints, confidence, and error attribution on an attempt event", () => {
    const parsed = attemptEventSchema.parse({
      ...attempt,
      assisted: true,
      hintCount: 2,
      confidence: 1,
      errorCause: "concept",
      correct: false,
    });
    expect(parsed).toMatchObject({
      durationMs: 12000,
      hintCount: 2,
      confidence: 1,
      errorCause: "concept",
      assisted: true,
    });
  });

  it("rejects client-authored correctness, syllabus point, and ability slice", () => {
    const practiceSessionId = "66666666-6666-4666-8666-666666666666";
    const attackerPoint = "77777777-7777-4777-8777-777777777777";
    expect(
      submitAttemptRequestSchema.safeParse({
        practiceSessionId,
        answer: "wrong",
        confidence: 5,
        errorCause: null,
        idempotencyKey: "attempt-0001",
        correct: true,
        syllabusPointId: attackerPoint,
        abilitySlice: "transfer",
      }).success,
    ).toBe(false);
    expect(
      submitAttemptRequestSchema.safeParse({
        practiceItemId: id,
        syllabusPointId: attackerPoint,
        contentVersion: 1,
        abilitySlice: "transfer",
        answer: "wrong",
        correct: true,
        assisted: false,
        durationMs: 1,
        hintCount: 0,
        confidence: 5,
        errorCause: null,
        idempotencyKey: "attempt-0001",
      }).success,
    ).toBe(false);
  });

  it("requires an idempotency key before an attempt can be submitted", () => {
    const body = {
      practiceSessionId: "66666666-6666-4666-8666-666666666666",
      answer: "A",
      confidence: 3,
      errorCause: null,
    };
    expect(submitAttemptRequestSchema.parse({ ...body, idempotencyKey: "attempt-key-01" }).idempotencyKey).toBe(
      "attempt-key-01",
    );
    expect(() => submitAttemptRequestSchema.parse({ ...body, idempotencyKey: "short" })).toThrow();
  });

  it("parses a submit response that echoes the stored attempt event", () => {
    const status = {
      syllabusPointId: item.syllabusPointId,
      status: "usable" as const,
      summaryMetrics: [{ key: "coverage", label: "证据覆盖", value: "有效证据 1/6" }],
      reasonCodes: ["partial-mastery"],
      recommendedActions: [{ code: "variant", label: "1道变式题巩固", estimatedMinutes: 10 }],
      evidenceSnapshotId: "snap-test",
      strategyVersion: "assess-1",
      modelVersion: "rules-2",
      computedAt: now,
    };
    const parsed = submitAttemptResponseSchema.parse({ event: attempt, status });
    expect(parsed.event.idempotencyKey).toBe("attempt-key-01");
    expect(parsed.event.contentVersion).toBe(2);
    expect(parsed.status.syllabusPointId).toBe(item.syllabusPointId);
    expect(() => submitAttemptResponseSchema.parse({ event: attempt })).toThrow();
  });
});
