import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CourseSprintMode } from "../../courses/course-sprint-mode";
import { sprintCourseHref, sprintCourseScope } from "./sprint-course-route";

const id = "11111111-1111-4111-8111-111111111111";
describe("course sprint navigation", () => {
  it("moves valid legacy links to course mode without dropping search context", () => {
    const href = sprintCourseHref({ courseId: id, mode: "old", tab: "sources", filter: ["a", "b"] });
    const url = new URL(href!, "http://localhost");
    expect(url.pathname).toBe(`/opening/courses/${id}`);
    expect(url.searchParams.get("mode")).toBe("sprint");
    expect(url.searchParams.get("tab")).toBe("sources");
    expect(url.searchParams.getAll("filter")).toEqual(["a", "b"]);
    expect(url.searchParams.has("courseId")).toBe(false);
  });
  it("chooses a course for missing, invalid or repeated course identifiers", () => {
    expect(sprintCourseHref({})).toBeNull();
    expect(sprintCourseHref({ courseId: "https://example.com" })).toBeNull();
    expect(sprintCourseHref({ courseId: [id, id] })).toBeNull();
  });
  it("uses actual persisted binding to distinguish unknown, unbound and foreign course records", () => {
    expect(sprintCourseScope(id, undefined)).toBe("loading");
    expect(sprintCourseScope(id, null)).toBe("unbound");
    expect(sprintCourseScope(id, { courseId: "other" })).toBe("other");
    expect(sprintCourseScope(id, { courseId: id })).toBe("match");
    expect(sprintCourseScope(undefined, null)).toBe("unscoped");
  });
  it("keeps an archived course outside the writable sprint view", () => {
    const html = renderToStaticMarkup(createElement(CourseSprintMode, { course: { id, title: "数学", slug: "math", description: "", createdAt: "2026-01-01", updatedAt: "2026-01-01", archivedAt: "2026-10-21" } }));
    expect(html).toContain("课程已归档");
    expect(html).not.toContain("开始摸底");
    expect(html).not.toContain("导入预置考点");
  });
});
