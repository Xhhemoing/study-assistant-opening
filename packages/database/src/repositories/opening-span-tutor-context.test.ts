import { expect, it } from "vitest";
import { spanTutorQuestionInScope, spanTutorExactProjection } from "./opening-span-tutor-context";
import type { SnapshotObservation } from "@aistudy/domain";
it("does not hijack unrelated course teaching under a span-only grant", () => {
  expect(spanTutorQuestionInScope("请解释特征值与特征向量")).toBe(false);
  expect(spanTutorQuestionInScope("请讲微积分")).toBe(false);
  expect(spanTutorQuestionInScope("span 是什么")).toBe(true);
  expect(spanTutorQuestionInScope("继续学习")).toBe(true);
});
it("preserves help facts while refusing to turn an AI rubric into M1 correctness", () => {
  const row: SnapshotObservation = { id: "head", skillLabel: "span", attemptedAt: "2026-10-27T00:00:00Z", assistance: "hinted",
    verifiedCorrect: "yes", independentAttempt: "no", usableForCurrentVersion: "yes", problemId: "p" };
  expect(spanTutorExactProjection([row], [{ id: "head", evaluatorVersion: "ai-rubric-v1" }])).toEqual([{ ...row, verifiedCorrect: "unknown" }]);
  expect(spanTutorExactProjection([row], [{ id: "head", evaluatorVersion: "span-exact-v1" }])).toEqual([row]);
});
