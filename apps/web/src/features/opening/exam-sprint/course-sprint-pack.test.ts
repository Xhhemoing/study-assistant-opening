import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CourseSprintPack, coursePackStatus } from "./course-sprint-pack";

const id = "11111111-1111-4111-8111-111111111111";
describe("course sprint sample pack gate", () => {
  it("treats only a course-scoped binding as bound", () => {
    expect(coursePackStatus(null)).toBe("unbound");
    expect(coursePackStatus({ integration: { binding: null } })).toBe("unbound");
    expect(coursePackStatus({ integration: { binding: { courseId: id } }, overview: {} })).toBe("bound");
  });
  it("shows a course-materials empty state and keeps the sample pack collapsed for unbound courses", () => {
    const html = renderToStaticMarkup(createElement(CourseSprintPack, { courseId: id, initialStatus: "unbound" }));
    expect(html).toContain("这门课还没有冲刺题包");
    expect(html).toContain(`/opening/courses/${id}?tab=materials`);
    expect(html).toContain("导入示例题包");
    expect(html).not.toContain("对应真实资料");
    expect(html).not.toContain("<details open");
  });
  it("does not render pack content while checking the binding", () => {
    const html = renderToStaticMarkup(createElement(CourseSprintPack, { courseId: id }));
    expect(html).not.toContain("导入示例题包");
    expect(html).not.toContain("题包训练");
  });
});
