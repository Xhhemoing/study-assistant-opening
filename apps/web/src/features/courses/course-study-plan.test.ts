import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CourseStudyPlanView } from "@aistudy/contracts";
import { CourseStudyPlanContent, lessonStatusLabel, studyPlanSummary } from "./course-study-plan";

const COURSE = "11111111-1111-4111-8111-111111111111";
const lessons: CourseStudyPlanView["lessons"] = [
  { number: 1, title: "Jacobian · Inverse Function Theorem", pageFrom: 1, pageTo: 4, status: "taught", date: "2026-10-15" },
  { number: 2, title: "Implicit Function Theorem", pageFrom: 5, pageTo: 7, status: "today", date: "2026-10-16" },
  { number: 3, title: "Lagrange Multipliers", pageFrom: 18, pageTo: 21, status: "planned", date: "2026-10-17" },
];
const planned: CourseStudyPlanView = {
  courseId: COURSE, plan: { lessonsPerDay: 3, lessonMinutes: 45, startDate: "2026-10-15" }, targetDate: "2026-10-16",
  lessons, reviewDates: ["2026-10-16", "2026-10-18"], finishDate: "2026-10-17", behind: true, noMaterial: false,
};
const render = (view: CourseStudyPlanView) => renderToStaticMarkup(createElement(CourseStudyPlanContent, {
  view, busy: false, error: "", today: "2026-10-16", onSave: vi.fn(), onStop: vi.fn(),
}));

describe("course study plan", () => {
  it("summarises pace, finish day and reviews, and warns when the target is missed", () => {
    expect(studyPlanSummary(planned)).toBe("共 3 课，已学 1 课；每天 3 节、每节 45 分钟，预计 10月17日 学完新内容；之后按第 1、3、7 天安排复习（下次 10月16日）。");
    const html = render(planned);
    expect(html).toContain("赶不上 10月16日 的截止日");
    expect(html).toContain("更新计划");
    expect(html).toContain("停止计划");
    expect(html).toContain("第 5–7 页");
  });

  it("labels each lesson by when it is taught", () => {
    expect(lessons.map(lessonStatusLabel)).toEqual(["10月15日 已学", "今天", "10月17日"]);
    expect(lessonStatusLabel({ ...lessons[2]!, status: "unscheduled", date: null })).toBe("未排上");
  });

  it("offers to create a plan, or explains that materials come first", () => {
    const html = render({ ...planned, plan: null, targetDate: null, behind: false, finishDate: null, reviewDates: [] });
    expect(html).toContain("生成学习计划");
    expect(html).not.toContain("停止计划");
    expect(render({ ...planned, plan: null, lessons: [], noMaterial: true })).toContain("上传并解析课程材料后");
  });
});
