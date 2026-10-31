import { expect, it } from "vitest";
import type { LearningAttempt, LearningObservation } from "@aistudy/contracts";
import { getSpanProblem } from "@aistudy/domain";
import { adaptSpanQuestion, adaptSpanResult, adaptSpanHelp, adaptSpanNext } from "./span";
const id = "11111111-1111-4111-8111-111111111111";
const attempt = { id, itemVersionId: id, spanExercise: getSpanProblem("span-independent-3d")! } as LearningAttempt;
it("adapts a real span question without inventing time or enabling photos", () => {
  const step = adaptSpanQuestion(attempt);
  expect(step).toMatchObject({ kind: "question", estimateMinutes: null, answerModes: ["text"], attemptRef: { id, itemVersionId: id } });
  expect(step.prompt).toContain("span");
});
it("keeps authoritative evaluation separate from assistance and pending grading", () => {
  const record = { assistance: "hinted", serverEvaluation: { decision: "correct", reasonCodes: ["verified_exactly"] } } as LearningObservation;
  expect(adaptSpanResult(record)).toEqual({ outcome: "correct", assistance: "hinted", reasonCode: "verified_exactly" });
  expect(adaptSpanResult({ ...record, serverEvaluation: null }, "grading").outcome).toBe("pending");
  expect(adaptSpanResult({ ...record, serverEvaluation: null }, "needs_manual").outcome).toBe("needs_manual");
  expect(adaptSpanHelp("revealed", [1, 2], ["方向", "定义"], false)).toMatchObject({ level: "revealed", hintsShown: 2, canRequest: true });
});
it("adapts real successor choices and rejects destinations outside the course", () => {
  const href = `/opening/courses/${id}/study/span?lesson=${id}`;
  expect(adaptSpanNext({ kind: "ready", href, activityId: id, sessionId: id, courseId: id, label: "继续新题", resumed: false }, id)).toMatchObject({ action: href, label: "继续新题", estimateMinutes: null, reasonCode: null });
  expect(() => adaptSpanNext({ kind: "choice", reason: "source_unavailable", primary: { href: "https://evil.test", label: "继续" } }, id)).toThrow();
});
