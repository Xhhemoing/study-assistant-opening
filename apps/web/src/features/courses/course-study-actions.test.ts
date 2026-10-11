import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CourseStudyActions } from "./course-study-actions";
import { CourseLearningView } from "../opening/learning/course-view";

it("keeps a single primary practice CTA without competing materials CTA (CT-01/02)", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyActions, { assetCount: 0, goalCount: 0 }));
  expect(html).toContain('href="#course-practice"');
  expect(html).toContain("开始独立练习");
  expect(html).toContain('href="#course-learning-records"');
  expect(html).toContain('href="/library/new"');
  expect(html).not.toContain('href="#course-assets"');
  expect(html).toMatch(/选主题/);
  expect(html).not.toMatch(/\s(?:aria-)?disabled(?:=|>)/u);
});

it("keeps Opening note actions under the Opening library", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyActions, { assetCount: 0, goalCount: 0, opening: true }));
  expect(html).toContain('href="/opening/library?tab=notes"');
  expect(html).not.toContain('href="/library/new"');
});

it("links practice and record actions to existing sections while records are still loading", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningView, { courseId: "course" }));
  expect(html).toContain('id="course-practice"');
  expect(html).toContain('id="course-learning-records"');
  expect(html).toContain("开始本次练习");
  expect(html).toContain("选主题 → 作答 → 保存");
  expect(html).toContain("更多选项（材料 / 题干）");
  expect(html.indexOf('id="course-practice"')).toBeLessThan(html.indexOf('id="course-learning-records"'));
});

it("omits the goal counter when Opening hides goal data", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyActions, { assetCount: 0, opening: true }));
  expect(html).not.toContain("个学习目标");
  expect(html).toContain("0 份课程材料");
});
