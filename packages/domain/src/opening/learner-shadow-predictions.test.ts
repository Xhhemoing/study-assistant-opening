import { expect, it } from "vitest";
import { assembleLearnerState } from "./learner-state";
import { courseEvidence } from "./learning-summary-fixtures";
import { compareLearnerShadow, predictLearnerShadow } from "./learner-shadow-predictions";
it("uses ordered features and excludes future, mismatched requirements and held-out families", () => {
  const [feature] = assembleLearnerState({ evidence: courseEvidence(), stateVersion: "v1", dataAsOf: "2026-10-19T00:00:00Z" }).features;
  const a = { ...feature!, courseId: "course", requirementKey: "requirement", observationId: "old", attemptedAt: "2026-10-17T00:00:00Z", recordedAt: "2026-10-17T00:00:00Z" };
  const result = predictLearnerShadow({ courseId: "course", requirementKey: "requirement", cutoff: "2026-10-19T00:00:00Z", excludedProblemIds: ["same-family"],
    features: [a, { ...a, observationId: "same-family" }, { ...a, observationId: "future", attemptedAt: "2026-10-20T00:00:00Z" }, { ...a, observationId: "wrong", requirementKey: "other" }] });
  expect(result.evidenceObservationIds).toEqual(["old"]);
  expect(result.predictions.map(row => row.modelId)).toEqual(["classical-bkt", "pfa", "smoothed-frequency"]);
  expect(result.predictions.every(row => row.calibrated === false && row.probability > 0 && row.probability < 1)).toBe(true);
  const compared = compareLearnerShadow([{ predictions: result.predictions, correct: true, familyKey: "held-out", predictedAt: "2026-10-19T00:00:00Z" }]);
  expect(compared).toMatchObject({ mode: "shadow", calibrated: false, count: 1, families: ["held-out"] });
});

it("reports held-out failure denominators at a predeclared threshold and null with no qualifying samples", () => {
  const predictions = (["classical-bkt", "pfa", "smoothed-frequency"] as const).map(modelId => ({ modelId, modelVersion: "1" as const, calibrated: false as const, probability: 0.9, parameters: {} }));
  const rows = [{ predictions, correct: false, familyKey: "reserved-family", predictedAt: "2026-10-19T00:00:00Z" }];
  expect(compareLearnerShadow(rows, { advanceThreshold: 0.8 }).models[0]).toMatchObject({ count: 1, aboveThresholdCount: 1, failedAboveThreshold: 1, failureRateAboveThreshold: 1 });
  expect(compareLearnerShadow(rows, { advanceThreshold: 0.95 }).models[0]).toMatchObject({ count: 1, aboveThresholdCount: 0, failedAboveThreshold: 0, failureRateAboveThreshold: null });
  expect(compareLearnerShadow([]).models[0]?.failureRateAboveThreshold).toBeNull();
  expect(() => compareLearnerShadow(rows, { advanceThreshold: 1.1 })).toThrow(/threshold/);
});

it("fails visibly on corrupt stored probabilities rather than producing a misleading score", () => {
  expect(() => compareLearnerShadow([{ predictions: [{ modelId: "pfa", modelVersion: "1", calibrated: false, probability: Number.NaN, parameters: {} }], correct: true, familyKey: "family", predictedAt: "2026-10-19T00:00:00Z" }])).toThrow(/persisted/);
});

it("does not train BKT or PFA on an AI grader's uncalibrated judgments", () => {
  const [feature] = assembleLearnerState({ evidence: courseEvidence(), stateVersion: "v1", dataAsOf: "2026-10-19T00:00:00Z" }).features;
  const input = { features: [feature!], courseId: feature!.courseId, requirementKey: feature!.requirementKey!,
    cutoff: "2026-10-21T08:00:00Z", excludedProblemIds: [] };
  const aiFeature = { ...feature!, observationId: "ai-result", eligibility: { ...feature!.eligibility,
    reasonCodes: [...feature!.eligibility.reasonCodes, "ai_graded_correct" as const] } };
  const result = predictLearnerShadow({ ...input, features: [feature!, aiFeature] });
  expect(result).toEqual(predictLearnerShadow(input));
  expect(result.evidenceObservationIds).not.toContain("ai-result");
});
