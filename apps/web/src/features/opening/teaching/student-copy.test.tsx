import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { HintLadder } from "./hint-ladder";
import { studentCopy } from "./student-copy";
import { InlineAttempt } from "./inline-attempt";
import { SpanSessionSummary } from "./span/span-session-summary";
import { LearnerStatePanel } from "./learner-state-panel";
import { learningObservation } from "../../../../../../packages/domain/src/opening/learning-summary-fixtures";

// Guard the vocabulary boundary, not a frozen copy snapshot. Ordinary teaching
// words such as “独立思考” or mathematical “证明” remain valid.
const measurementTerms = /封存|曝光|回执|题族|资格|BKT|Brier|不计独立|独立答对估计/;
it("keeps the student attempt, feedback and summary free of measurement labels", () => {
  const id = learningObservation.courseId;
  const components = [
    createElement(InlineAttempt, { blockId: id, prompt: "求矩阵的秩", context: { id, courseId: id, sourceIds: [], contentVersion: 1, intentSummary: "矩阵秩", status: "active", onCourseAssociated() {} } }),
    createElement(LearnerStatePanel, { observation: { ...learningObservation, assistance: "hinted" } }),
    createElement(SpanSessionSummary, { observations: [{ ...learningObservation, assistance: "hinted" }] }),
  ];
  for (const component of components) {
    const html = renderToStaticMarkup(component);
    expect(html).not.toMatch(measurementTerms);
    expect(html).not.toMatch(/依赖提示|独立核对正确|使用帮助作答|记录的技能|学习记录所属课程/);
  }
});
it("keeps the shared student actions free of measurement jargon", () => {
  for (const text of Object.values(studentCopy)) expect(text).not.toMatch(measurementTerms);
});
it("welcomes help without exposing measurement bookkeeping", () => {
  const html = renderToStaticMarkup(createElement(HintLadder, {
    delivered: [], next: { label: "方向提示", pending: false, request() {} },
  }));
  expect(html).not.toMatch(measurementTerms);
  expect(html).toContain(studentCopy.hintEncouragement);
});
