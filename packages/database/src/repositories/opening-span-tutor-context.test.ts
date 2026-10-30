import { expect, it } from "vitest";
import { spanTutorQuestionInScope, spanTutorExactProjection, spanTutorReceiptDecision } from "./opening-span-tutor-context";
import type { SnapshotObservation } from "@aistudy/domain";
it("does not hijack unrelated course teaching under a span-only grant", () => {
  expect(spanTutorQuestionInScope("请解释特征值与特征向量")).toBe(false);
  expect(spanTutorQuestionInScope("请讲微积分")).toBe(false);
  expect(spanTutorQuestionInScope("span 是什么")).toBe(true);
  expect(spanTutorQuestionInScope("继续学习")).toBe(true);
  expect(spanTutorQuestionInScope("完全不会，先学")).toBe(true);
  for (const message of ["先学特征值", "不要先学", "别先学", "不想先学", "“先学”是什么意思", "用英文讲解"]) expect(spanTutorQuestionInScope(message)).toBe(false);
});
it("reads historical decisions without recalculating the original phase or action", () => {
  const ruleDecision = { activityKind: "diagnose", focusObservationId: null, reasonCode: "no_evidence" };
  expect(spanTutorReceiptDecision({ policyVersion: "next-learning-step-1/span-tutor-execution-1", intentVersion: JSON.stringify({ ruleDecision }) })).toEqual(ruleDecision);
});
it("preserves help facts while refusing to turn an AI rubric into M1 correctness", () => {
  const row: SnapshotObservation = { id: "head", skillLabel: "span", attemptedAt: "2026-10-27T00:00:00Z", assistance: "hinted",
    verifiedCorrect: "yes", independentAttempt: "no", usableForCurrentVersion: "yes", problemId: "p" };
  expect(spanTutorExactProjection([row], [{ id: "head", evaluatorVersion: "ai-rubric-v1" }])).toEqual([{ ...row, verifiedCorrect: "unknown" }]);
  expect(spanTutorExactProjection([row], [{ id: "head", evaluatorVersion: "span-exact-v1" }])).toEqual([row]);
});
