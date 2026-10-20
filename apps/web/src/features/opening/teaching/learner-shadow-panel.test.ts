import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LearnerShadowComparisonBody, learnerShadowComparisonSchema, type LearnerShadowComparison } from "./learner-shadow-panel";
const report: LearnerShadowComparison = { mode: "shadow", calibrated: false, count: 0, families: [], cutoff: null,
  advanceThreshold: 0.8, thresholdPolicyVersion: "shadow-advance-threshold-v1", dataAsOf: "2026-10-19T10:00:00.000Z", excluded: {},
  models: (["classical-bkt", "pfa", "smoothed-frequency"] as const).map(modelId => ({ modelId, count: 0, aboveThresholdCount: 0, failedAboveThreshold: 0,
    failureRateAboveThreshold: null, brier: null, logLoss: null })) };
it("keeps absent samples unknown and describes experimental limits", () => {
  const html = renderToStaticMarkup(createElement(LearnerShadowComparisonBody, { report }));
  expect(html).toContain("仅实验，三个模型均未校准");
  expect(html).toContain("样本不足");
  expect(html).toContain("0 / 0");
  expect(html).not.toContain("0.0%");
  expect(html).toContain("训练排除待预测题族");
});
it("shows the declared threshold and actual failure numerator with its denominator", () => {
  const observed = { ...report, count: 3, families: ["new-family"], models: report.models.map(model => ({ ...model, count: 3, aboveThresholdCount: 3,
    failedAboveThreshold: 2, failureRateAboveThreshold: 2 / 3, brier: 0.25, logLoss: 0.5 })) };
  const html = renderToStaticMarkup(createElement(LearnerShadowComparisonBody, { report: observed }));
  expect(html).toContain("80%"); expect(html).toContain("2 / 3"); expect(html).toContain("66.7%"); expect(html).toContain("0.250");
});
it("rejects a response that claims these experimental models are calibrated", () => {
  expect(learnerShadowComparisonSchema.safeParse({ ...report, calibrated: true }).success).toBe(false);
});
