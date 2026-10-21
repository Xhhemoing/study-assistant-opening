import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { LearningObservation } from "@aistudy/contracts";
import { BilingualProblem, ProblemCard } from "./problem-card";
import { FeedbackPanel } from "./feedback-panel";
import { HintLadder } from "./hint-ladder";
import { LessonFlow } from "./lesson-flow";
import { insertMathSymbol, MathInput } from "./math-input";
import { learnerEvidenceState } from "./learner-evidence-state";
import { LearnerStatePanel } from "./learner-state-panel";
import { listSpanTeachingProblems, spanProblemStem } from "@aistudy/domain";
import { spanProblemText } from "./span/span-problem-text";
const id = "11111111-1111-4111-8111-111111111111";
function observation(overrides: Partial<LearningObservation> = {}): LearningObservation {
  return { id, workspaceId: id, courseId: id, sessionId: id, attemptId: id, problemId: id, itemVersionId: id,
    skillLabel: "span", sourceIds: [id], sourceTurnIds: [], answer: "my answer", outcome: "correct", assistance: "independent",
    clientKey: "lesson-test", verdictSource: "deterministic", referenceSourceId: null, evidenceVerdict: "MASTERY_NOT_ESTABLISHED", occurredAt: "2026-10-21T00:00:00.000Z",
    eligibility: { independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown", reasonCodes: [], policyVersion: "opening-evidence-v3" },
    ...overrides,
  };
}
it("shows Chinese meaning before the original for bilingual learning", () => {
  const html = renderToStaticMarkup(createElement(BilingualProblem, { original: "Determine membership.", translation: "判断是否属于。" }));
  expect(html.indexOf("判断是否属于。")).toBeLessThan(html.indexOf("Determine membership."));
  expect(html).not.toContain("<details");
});
it("keeps the original available when Chinese is selected", () => {
  const html = renderToStaticMarkup(createElement(BilingualProblem, { original: "Question", translation: "题意", language: "zh" }));
  expect(html).toContain("查看英文题干"); expect(html).toContain("Question");
  expect(html.indexOf("题意")).toBeLessThan(html.indexOf("查看英文题干"));
});
it("does not invent a translation when the source provides only one language", () => {
  const html = renderToStaticMarkup(createElement(ProblemCard, { prompt: "A source-only question." }));
  expect(html).toContain("A source-only question."); expect(html).not.toContain("中文题意");
});
it("shows only server-delivered hints, without implying missing levels are available", () => {
  expect(renderToStaticMarkup(createElement(HintLadder, { delivered: [] }))).toBe("");
  const html = renderToStaticMarkup(createElement(HintLadder, { delivered: [{ id: "h", label: "方向提示", text: "已交付的提示" }] }));
  expect(html).toContain("已交付的提示"); expect(html).not.toContain("查看完整示范");
});
it.each(listSpanTeachingProblems())("preserves the full canonical span task and its requirements for $id", problem => {
  const wording = spanProblemText(problem);
  expect(wording.chinese).toBe(spanProblemStem(problem));
  expect(wording.english).toContain("give any pair of coefficients satisfying αv+βw=u and check every coordinate");
  expect(wording.english).toContain("explain why the system is inconsistent");
  expect(wording.english).toContain(`u=(${problem.target.join(", ")})`);
});
it("keeps interactive feedback outside the live announcement", () => {
  const html = renderToStaticMarkup(createElement(FeedbackPanel, { verdict: "unverified", title: "原答案已保存", evidence: "尚未经独立评分" }, createElement("button", { type: "button" }, "自行核对")));
  expect(html).toMatch(/role="status"[\s\S]*?<\/div><button/);
  expect(html).not.toContain("答对了");
});
it("marks the current phase without claiming earlier phases were completed", () => {
  const html = renderToStaticMarkup(createElement(LessonFlow, { phase: "feedback", children: "已保存的反馈" }));
  expect(html.match(/aria-current="step"/g)).toHaveLength(1); expect(html).toContain("核对反馈");
  expect(html).not.toContain("已完成");
});
it("inserts symbols at the selection while preserving the rest of the answer", () => {
  expect(insertMathSymbol("before XY after", "$\\alpha$", 7, 9, 100)).toEqual({ value: "before $\\alpha$ after", cursor: 15 });
  expect(insertMathSymbol("abc", "long", 3, 3, 4)).toEqual({ value: "abc", cursor: 3 });
});
it("renders a disabled answer editor with an accessible label and safe text preview", () => {
  const html = renderToStaticMarkup(createElement(MathInput, { label: "我的原答案", value: "<script>alert(1)</script> $x^2$", onChange: () => undefined, disabled: true }));
  expect(html).toContain("<label"); expect(html).toContain("disabled"); expect(html).not.toContain("<script>"); expect(html).toContain("预览不会判分");
});
it("requires all server qualifications for independent completion", () => {
  expect(learnerEvidenceState(observation())).toBe("independent");
  for (const field of ["independentAttempt", "verifiedCorrect", "usableForCurrentVersion"] as const) {
    const value = observation(); value.eligibility![field] = "unknown";
    expect(learnerEvidenceState(value)).toBe("insufficient");
  }
  expect(learnerEvidenceState(observation({ eligibility: undefined, verdictSource: "self_report" }))).toBe("insufficient");
});
it("prioritizes revealed work and verified error over hinted success", () => {
  const helped = observation({ assistance: "hinted" }); helped.eligibility!.independentAttempt = "no";
  expect(learnerEvidenceState(helped)).toBe("hinted");
  expect(learnerEvidenceState({ ...helped, assistance: "revealed" })).toBe("retest");
  helped.eligibility!.verifiedCorrect = "no"; expect(learnerEvidenceState(helped)).toBe("retest");
});
it("does not relabel familiarity or unavailable history as hint dependency", () => {
  const seen = observation(); seen.eligibility!.independentAttempt = "no"; seen.eligibility!.reasonCodes = ["exam_family_already_seen"];
  expect(learnerEvidenceState(seen)).toBe("insufficient");
  expect(learnerEvidenceState(observation({ revisionKind: "retract" }))).toBe("insufficient");
  expect(learnerEvidenceState(observation({ effectiveHeadId: "other" }))).toBe("insufficient");
});
it("does not reuse prior qualification while trust is refreshing", () => {
  const html = renderToStaticMarkup(createElement(LearnerStatePanel, { observation: observation(), refreshing: true }));
  expect(html).toContain('data-learner-evidence-state="insufficient"'); expect(html).not.toContain("独立完成");
});
