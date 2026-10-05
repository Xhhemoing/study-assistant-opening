import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CourseList } from "./course-list";

it("keeps Opening course creation inside the Opening route", () => {
  const html = renderToStaticMarkup(createElement(CourseList, { opening: true }));
  expect(html).toContain("/opening/courses/new");
  expect(html).not.toContain("/learn/courses/new");
});
