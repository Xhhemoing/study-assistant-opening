import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LearningAttemptForm } from "./attempt-form";

it("keeps a requested matrix entry disabled until the outer draft has been read", () => {
  const html = renderToStaticMarkup(createElement(LearningAttemptForm, { courseId: "course", initialMode: "matrix", initialMatrixKey: "multiplication", initialMatrixVariant: 1, onRecorded() {} }));
  expect(html).toContain("正在恢复练习");
  expect(html).toContain('<fieldset disabled=""');
  expect(html).not.toContain("开始矩阵练习");
});

it("starts pasted questions with a saved problem even when no source is selected", async () => {
  const { practiceQuestionInput } = await import("./attempt-form");
  expect(practiceQuestionInput("  计算 17 × 23  ", "")).toEqual({ stemSnapshot: "计算 17 × 23", artifactKind: "reference_item" });
  expect(practiceQuestionInput("题目", "source-id")).toEqual({ sourceId: "source-id", stemSnapshot: "题目", artifactKind: "reference_item" });
  expect(practiceQuestionInput(" ", "")).toBeUndefined();
});
