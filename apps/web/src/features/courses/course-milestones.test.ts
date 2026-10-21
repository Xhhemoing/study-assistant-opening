import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CourseMilestones, CourseMilestoneHistory, milestoneUpdate } from "./course-milestones";
import type { CourseMilestone } from "@aistudy/contracts";

const item: CourseMilestone = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "矩阵乘法", successCriteria: "独立完成两道变式。",
  targetDate: null, evidenceRefs: [], revision: 3, status: "confirmed_by_learner", confirmedAt: "2026-10-16T12:00:00.000Z",
  history: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "矩阵乘法", successCriteria: "独立完成一道题。", targetDate: null,
    evidenceRefs: [], revision: 2, status: "planned", confirmedAt: null }] };

it("submits only editable fields and an explicit confirmation action", () => {
  expect(milestoneUpdate(item, false)).toEqual({ id: item.id, title: item.title, successCriteria: item.successCriteria,
    targetDate: null, evidenceRefs: [], confirm: false });
  expect(milestoneUpdate(item)).not.toHaveProperty("confirm");
  expect(milestoneUpdate(item)).not.toHaveProperty("history");
  expect(milestoneUpdate(item)).not.toHaveProperty("confirmedAt");
});

it("distinguishes learner confirmation from mastery and retains visible previous standards", () => {
  const html = renderToStaticMarkup(createElement(CourseMilestones, { courseId: item.id,
    goal: { targetDate: null, weeklyMinutes: 120, revision: 4, milestones: [item] },
    api: { patchAdaptivePrefs: vi.fn(), getAdaptivePrefs: vi.fn(), listTeachingActivities: vi.fn() }, onSaved: vi.fn() }));
  expect(html).toContain("已由你确认");
  expect(html).toContain("均不自动代表掌握");
  expect(html).toContain("重新待核对");
  expect(html).toContain("查看此前标准与记录");
  expect(html).not.toContain("独立完成一道题");
  expect(html).not.toContain("<details");
  const history = renderToStaticMarkup(createElement(CourseMilestoneHistory, { item }));
  expect(history).toContain("独立完成一道题");
  expect(history).toContain("待核对");
  expect(history).not.toContain("已由你确认");
});
