import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PracticeDraftRecovery } from "./practice-draft-recovery";

it("keeps the exact raw answer selectable and offers a concrete course history exit", () => {
  const html = renderToStaticMarkup(createElement(PracticeDraftRecovery, { courseId: "course-id", answer: "a < b\n原始答案", pending: false, onResume() {} }));
  expect(html).toMatch(/readonly=""/i);
  expect(html).toContain("a &lt; b\n原始答案");
  expect(html).toContain("复制原答案");
  expect(html).toContain('/opening/courses/course-id#course-learning-records');
  expect(html).not.toContain('type="submit"');
});
