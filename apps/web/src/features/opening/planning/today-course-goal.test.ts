import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { currentTodayCourse, type TodayCourse, type TodayResumeState } from "./today-read";
import { todayCourseGoalSummary } from "./today-course-goal";
import { ContinueCard } from "./continue-card";
import { TodayDashboard } from "./today-dashboard";

const course: TodayCourse = { id: "course", title: "线性代数", archivedAt: null, targetDate: "2026-10-31", weeklyMinutes: 420, learningMode: "auto" };
afterEach(() => vi.useRealTimers());

it("counts calendar days in the workspace zone and does not call every deadline an exam", () => {
  const now = new Date("2026-10-21T23:30:00Z");
  expect(todayCourseGoalSummary(course, "Asia/Shanghai", now)).toBe("距目标 9 天 · 每天 60 分钟");
  expect(todayCourseGoalSummary(course, "America/New_York", now)).toBe("距目标 10 天 · 每天 60 分钟");
  expect(todayCourseGoalSummary({ ...course, learningMode: "exam" }, "Asia/Shanghai", now)).toBe("距考试 9 天 · 每天 60 分钟");
  expect(todayCourseGoalSummary(course, undefined, now)).toBe("距目标 9 天 · 每天 60 分钟");
});

it("handles today, passed targets, date-less goals and unavailable goal fields honestly", () => {
  expect(todayCourseGoalSummary(course, "UTC", new Date("2026-10-31T10:00:00Z"))).toBe("目标就在今天 · 每天 60 分钟");
  expect(todayCourseGoalSummary(course, "UTC", new Date("2026-11-02T10:00:00Z"))).toBe("目标日期已过 2 天 · 每天 60 分钟");
  expect(todayCourseGoalSummary({ ...course, targetDate: null, weeklyMinutes: 100 }, "UTC")).toBe("每天约 14.3 分钟");
  expect(todayCourseGoalSummary({ id: "legacy", title: "旧课程", archivedAt: null }, "UTC")).toBeNull();
});

it("keeps goal context with its activity and uses an active goal course only when there is no prior context", () => {
  const state: TodayResumeState = { kind: "ready", courses: { status: "ready", items: [{ ...course, id: "archived", archivedAt: "2026-01-01" }, course] } };
  expect(currentTodayCourse(state)).toEqual(course);
  expect(currentTodayCourse(state, { courseId: null })).toBeNull();
  expect(currentTodayCourse({ ...state, continueItem: { conversationId: "chat", title: "自由对话", courseId: null } })).toBeNull();
  const html = renderToStaticMarkup(createElement(ContinueCard, { course, activity: { title: "另一节", courseId: "other" } }));
  expect(html).not.toContain("每天");
});

it("shows the first course goal within the one existing ContinueCard and links to that course", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T23:30:00Z"));
  const html = renderToStaticMarkup(createElement(TodayDashboard, { state: { kind: "empty", courses: { status: "ready", items: [course] } },
    timeZone: "Asia/Shanghai", api: {} as never, teachingWorkspaceEnabled: false, teachingLoopEnabled: false, teachingLoopTrialEnabled: false }));
  expect(html.match(/data-continue-card="true"/g)).toHaveLength(1);
  expect(html).toContain("距目标 9 天 · 每天 60 分钟");
  expect(html).toContain('href="/opening/courses/course/study"');
});
