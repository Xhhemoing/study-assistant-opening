import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LearningAttemptForm } from "./attempt-form";

it("keeps a requested matrix entry disabled until the outer draft has been read", () => {
  const html = renderToStaticMarkup(createElement(LearningAttemptForm, { courseId: "course", initialMode: "matrix", initialMatrixKey: "multiplication", initialMatrixVariant: 1, onRecorded() {} }));
  expect(html).toContain("正在读取练习草稿");
  expect(html).toContain('<fieldset disabled=""');
  expect(html).not.toContain("开始矩阵练习");
});
