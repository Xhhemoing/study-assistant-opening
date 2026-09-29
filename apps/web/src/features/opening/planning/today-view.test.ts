import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TodayPlanView, TodayTaskList, localDateKey } from "./today-view";
import { shouldCloseTodayQueue, shouldOpenTodayQueue } from "./today-dashboard";
import { focusTodayTask } from "./today-task-selection";

it("starts the asynchronous Today read as loading rather than empty", () => {
  const html = renderToStaticMarkup(createElement(TodayPlanView));
  expect(html).toContain("正在加载任务");
  expect(html).not.toContain("暂无待完成任务");
});

it.each(["loading", "error"] as const)("does not report no tasks while the read is %s", (state) => {
  const html = renderToStaticMarkup(createElement(TodayTaskList, { tasks: [], state }));
  expect(html).toContain(state === "loading" ? "正在加载任务" : "任务暂时无法读取");
  expect(html).not.toContain("暂无待完成任务");
});

it("shows an empty result only after a successful read", () => {
  expect(renderToStaticMarkup(createElement(TodayTaskList, { tasks: [], state: "ready" }))).toContain("暂无待完成任务");
});

it("makes the specifically linked completed task focusable after loading", () => {
  const tasks = [{ id: "completed", title: "已完成的练习", status: "done" as const, minutes: 20, dueAt: null, priority: 1 }];
  const html = renderToStaticMarkup(createElement(TodayTaskList, { tasks, state: "ready", focusTaskId: "completed" }));
  expect(html).toContain('id="task-completed"');
  expect(html).toContain('tabindex="-1"');
  expect(html).toContain("已完成");
  expect(html).not.toContain("暂无待完成任务");
});

it("scrolls and focuses only once the matching asynchronous task node is supplied", () => {
  const element = { id: "task-completed", scrollIntoView: vi.fn(), focus: vi.fn() };
  focusTodayTask(null, "completed");
  focusTodayTask(element, "another-task");
  expect(element.scrollIntoView).not.toHaveBeenCalled();
  expect(element.focus).not.toHaveBeenCalled();
  focusTodayTask(element, "completed");
  expect(element.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  expect(element.focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("uses the local calendar date for the daily plan", () => {
  expect(localDateKey(new Date(2026, 8, 28, 0, 15))).toBe("2026-09-28");
});
it("allows all pending tasks to be reached without hiding the linked completed task", () => {
  const tasks = [
    { id: "done", title: "已完成任务", status: "done" as const, minutes: 20, dueAt: null, priority: 1 },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `task-${index}`, title: `待办${index}`, status: "pending" as const, minutes: 10, dueAt: null, priority: 1 })),
  ];
  const html = renderToStaticMarkup(createElement(TodayTaskList, { tasks, state: "ready", focusTaskId: "done", showAll: true }));
  expect(html).toContain("已完成任务");
  expect(html).toContain("待办4");
});

it("opens the mobile task queue for a focused deep link while ordinary entry stays collapsed", () => {
  expect(shouldOpenTodayQueue("task-1")).toBe(true);
  expect(shouldOpenTodayQueue("")) .toBe(false);
  expect(shouldOpenTodayQueue()).toBe(false);
});

it("keeps a focused deep-link queue open when async selection completes", () => {
  expect(shouldCloseTodayQueue("focus")).toBe(false);
  expect(shouldCloseTodayQueue("user")).toBe(true);
  expect(shouldCloseTodayQueue()).toBe(true);
});
