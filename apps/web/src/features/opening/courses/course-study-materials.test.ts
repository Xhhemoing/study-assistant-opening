import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CourseStudyMaterials } from "./course-study-materials";

const props = { materialsHref: "/opening/library?tab=materials", onRetry: () => {} };

it("opens available content directly without adding a second continue action", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyMaterials, { ...props, gate: "available", children: "current unit" }));
  expect(html).toBe("current unit");
});

it("keeps partially sourced content usable while showing the actual material warning", () => {
  const html = renderToStaticMarkup(createElement(CourseStudyMaterials, { ...props, gate: "partial", children: "current unit" }));
  expect(html).toContain('role="status"');
  expect(html).toContain("部分材料暂时无法读取");
  expect(html).toContain("重新核查材料");
  expect(html).toContain(`href="${props.materialsHref}"`);
  expect(html).toContain("current unit");
});

it("does not mount a lesson whose source access was withdrawn and offers recovery", () => {
  function BlockedLesson(): never { throw new Error("unavailable lesson mounted"); }
  const html = renderToStaticMarkup(createElement(CourseStudyMaterials, { ...props, gate: "unavailable", children: createElement(BlockedLesson) }));
  expect(html).toContain("材料不可用或已撤回");
  expect(html).toContain("重新核查材料");
  expect(html).toContain("查看课程材料");
});
