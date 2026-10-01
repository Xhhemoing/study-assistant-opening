import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CourseStudyActions } from "./course-study-actions";
import { CourseLearningView } from "../opening/learning/course-view";

it("keeps practice and note creation available for a course without materials or goals", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyActions, { assetCount: 0, goalCount: 0 }));
  expect(html).toContain('href="#course-practice"');
  expect(html).toContain('href="#course-assets"');
  expect(html).toContain('href="#course-learning-records"');
  expect(html).toContain('href="/library/new"');
  expect(html).not.toMatch(/\s(?:aria-)?disabled(?:=|>)/u);
});

it("links practice and record actions to existing sections while records are still loading", () => {
  const html = renderToStaticMarkup(createElement(CourseLearningView, { courseId: "course" }));
  expect(html).toContain('id="course-practice"');
  expect(html).toContain('id="course-learning-records"');
  expect(html).toContain("开始本次练习");
  expect(html.indexOf('id="course-practice"')).toBeLessThan(html.indexOf('id="course-learning-records"'));
});
