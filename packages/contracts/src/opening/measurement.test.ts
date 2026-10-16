import { describe, expect, it } from "vitest";
import { measurementActionInputSchema, measurementNextInputSchema, measurementPredictionSchema, measurementStartInputSchema } from "./measurement";

const trialId = "10000000-0000-4000-8000-000000000001";
describe("measurement trust boundaries", () => {
  it("accepts answers and observed external help without allowing client grading", () => {
    expect(measurementActionInputSchema.parse({ action: "answer", clientKey: "answer-01", answer: " b " }).action).toBe("answer");
    expect(measurementActionInputSchema.parse({ action: "help", clientKey: "external-01", kind: "external" }).action).toBe("help");
    for (const injected of [{ correct: true }, { firstAttempt: true }, { answeredAt: "2026-10-16T00:00:00Z" }, { probability: 1 }]) {
      expect(measurementActionInputSchema.safeParse({ action: "answer", clientKey: "answer-01", answer: "b", ...injected }).success).toBe(false);
    }
  });
  it("does not let the client choose a held-out item or bypass its due time", () => {
    expect(measurementNextInputSchema.parse({ trialId, clientKey: "next-0001" }).trialId).toBe(trialId);
    expect(measurementNextInputSchema.safeParse({ trialId, clientKey: "next-0001", itemId: "held-out", now: "2030-01-01" }).success).toBe(false);
    expect(measurementStartInputSchema.safeParse({ courseId: trialId, unitId: "custom-unreviewed", clientKey: "start-001" }).success).toBe(false);
  });
  it("requires a reason to withdraw a fact and preserves explicit null outcomes", () => {
    expect(measurementActionInputSchema.safeParse({ action: "retract", clientKey: "retract-1", reason: " " }).success).toBe(false);
    expect(measurementActionInputSchema.parse({ action: "retract", clientKey: "retract-1", reason: "误点，无法代表实际答案" }).action).toBe("retract");
  });
  it("rejects unusable predictor output at the persistence/HTTP boundary", () => {
    const prediction = { modelId: "bkt", modelVersion: "1", probability: 0.5, predictedAt: "2026-10-16T00:00:00.000Z", evidenceAttemptIds: [] };
    expect(measurementPredictionSchema.parse(prediction).probability).toBe(0.5);
    for (const probability of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      expect(measurementPredictionSchema.safeParse({ ...prediction, probability }).success).toBe(false);
    }
    expect(measurementPredictionSchema.safeParse({ ...prediction, evidenceAttemptIds: ["unknown"] }).success).toBe(false);
  });
});
