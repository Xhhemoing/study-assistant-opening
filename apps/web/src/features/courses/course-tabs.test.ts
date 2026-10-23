import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoursePanel, CourseTabs } from "./course-tabs";
import { courseTabHref, legacyCourseStudyHref, readCourseTab } from "./course-tabs-route";

describe("course section routes", () => {
  it("resolves old records, materials and media bookmarks before a stale tab", () => {
    expect(readCourseTab("?tab=overview", "#course-learning-records")).toBe("progress");
    expect(readCourseTab("?tab=overview", "#course-assets")).toBe("materials");
    expect(readCourseTab("?mediaSource=source&seekMs=4000")).toBe("materials");
    expect(readCourseTab("", "#course-media")).toBe("materials");
    expect(readCourseTab("", "#course-knowledge")).toBe("units");
    expect(readCourseTab("?tab=overview", "#course-units")).toBe("units");
    expect(readCourseTab("?tab=units&mediaSource=source")).toBe("units");
    expect(readCourseTab("?tab=unknown")).toBe("overview");
  });
  it("resolves six linked course sections and template section bookmarks", () => {
    for (const tab of ["overview", "practice", "review", "materials", "notes", "progress"] as const) {
      expect(readCourseTab(new URL(courseTabHref("course", tab), "http://localhost").search)).toBe(tab);
    }
    expect(readCourseTab("?section=study")).toBe("overview");
    expect(readCourseTab("?section=library")).toBe("materials");
    expect(readCourseTab("?section=practice")).toBe("practice");
    expect(courseTabHref("course", "notes", "?section=practice")).toBe("/opening/courses/course?tab=notes");
  });
  it("retains media and repeated query values when changing a section", () => {
    const href = courseTabHref("course / 1", "progress", "?mediaSource=source&seekMs=4000&filter=a&filter=b&tab=overview");
    expect(href.split("?")[0]).toBe("/opening/courses/course%20%2F%201");
    const query = new URL(href, "http://localhost").searchParams;
    expect(query.get("tab")).toBe("progress");
    expect(query.get("mediaSource")).toBe("source");
    expect(query.getAll("filter")).toEqual(["a", "b"]);
  });
  it("carries one valid original conversation through all six sections without retaining malformed ids", () => {
    const conversation = "11111111-1111-4111-8111-111111111111";
    for (const tab of ["overview", "practice", "review", "materials", "notes", "progress"] as const) {
      expect(new URL(courseTabHref("c", tab, `?conversation=${conversation}&activity=a`), "http://localhost").searchParams.get("conversation")).toBe(conversation);
    }
    expect(courseTabHref("c", "notes", "?conversation=invalid")).not.toContain("conversation");
    expect(courseTabHref("c", "notes", `?conversation=${conversation}&conversation=${conversation}`)).not.toContain("conversation");
    const html = renderToStaticMarkup(createElement(CourseTabs, { courseId: "c", conversationId: conversation, children: null }));
    expect(html.match(new RegExp(`conversation=${conversation}`, "g"))).toHaveLength(6);
  });
  it("preserves retest identity and practice targeting for legacy study links", () => {
    expect(legacyCourseStudyHref("c", "?retest=r&task=t&tab=progress", "#course-learning-records")).toBe("/opening/courses/c/study?retest=r&task=t");
    expect(legacyCourseStudyHref("c", "?skillLabel=span&requirementKey=exact", "#course-practice")).toBe("/opening/courses/c/study?skillLabel=span&requirementKey=exact&mode=practice");
    expect(legacyCourseStudyHref("c", "?activity=a&contentVersion=2", "#course-practice")).toBe("/opening/courses/c/study?activity=a&contentVersion=2");
    expect(legacyCourseStudyHref("c", "", "#course-assets")).toBeNull();
  });
  it("keeps inactive panel content mounted and provides ordinary navigable section links", () => {
    const html = renderToStaticMarkup(createElement(CourseTabs, { courseId: "c" },
      createElement(CoursePanel, { name: "overview", children: createElement("input", { name: "goal", defaultValue: "draft" }) }),
      createElement(CoursePanel, { name: "materials", children: createElement("input", { name: "material", defaultValue: "unsaved" }) }),
    ));
    expect(html).toContain('aria-current="page"');
    for (const label of ["学习", "练习", "复习", "资料", "笔记", "进展"]) expect(html).toContain(`>${label}</a>`);
    expect(html).not.toContain('role="tablist"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('href="/opening/courses/c?tab=materials"');
    expect(html).toMatch(/<section hidden="" aria-label="资料"[^>]*><input name="material" value="unsaved"/);
    expect(html).toContain('name="goal" value="draft"');
  });
});
