vi.mock("../settings/appearance-preferences", () => ({ useDiagnosticsEnabled: () => true }));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MatrixExerciseForm } from "./matrix-exercise-form";
import { LearningEvidenceEligibilityDetails } from "./eligibility-details";
it("offers real start controls, labels the built-in source honestly and blocks an empty material selection", () => {
  const html = renderToStaticMarkup(createElement(MatrixExerciseForm, {
    courseId: "course", sources: [], onRecorded() {}, onBack() {},
  }));
  expect(html).toContain("内置矩阵练习");
  expect(html).toContain("正在恢复矩阵练习");
  expect(html).toContain('<fieldset disabled=""');
  expect(html).toContain("这是内置矩阵练习");
  expect(html).toContain("选择可用课程材料");
  expect(html).toContain("请先添加并完成解析一份材料");
  expect(html).toMatch(/<button disabled=""[^>]*>开始矩阵练习<\/button>/);
  expect(html).toContain("矩阵标量乘法");
});
it("distinguishes an automatic verdict from a learner's documented reference check", () => {
  const html = renderToStaticMarkup(createElement(LearningEvidenceEligibilityDetails, { eligibility: {
    independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown",
    reasonCodes: ["deterministic_correct"], policyVersion: "opening-evidence-v1",
  } }));
  expect(html).toContain("内置题精确核算");
  expect(html).toContain("只覆盖这道结构化题目");
  expect(html).not.toContain("不代表系统客观判分");
});
it("seeds the exact exercise and variation of a new matrix entry while draft reads are pending", () => {
  const html = renderToStaticMarkup(createElement(MatrixExerciseForm, { courseId: "new-course", sources: [], initialKey: "addition", initialVariant: 2, onRecorded() {}, onBack() {} }));
  expect(html).toContain('<option value="addition" selected="">');
  expect(html).toContain("本次题组：3");
  expect(html).toContain('<fieldset disabled=""');
});
