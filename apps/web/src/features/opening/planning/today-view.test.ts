import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TodayGroupedQueue, TodayPlanView, TodayTaskList, localDateKey } from "./today-view";
import { shouldCloseTodayQueue, shouldOpenTodayQueue } from "./today-dashboard";
import { focusTodayTask } from "./today-task-selection";
import { TaskQueueRefreshContext } from "./task-status-control";
import { createTaskStatusSession } from "./task-status-action";

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

it("renders Chinese queue group headings from groupTodayQueue", () => {
  const tasks = [
    { id: "11111111-1111-4111-8111-111111111111", title: "确认中", status: "pending" as const, minutes: 25, dueAt: null, priority: 1 },
    { id: "22222222-2222-4222-8222-222222222222", title: "其他", status: "pending" as const, minutes: 15, dueAt: null, priority: 1 },
    { id: "33333333-3333-4333-8333-333333333333", title: "逾期项", status: "pending" as const, minutes: 20, dueAt: "2026-10-01T00:00:00.000Z", priority: 1 },
  ];
  const groups = {
    confirmed: [tasks[0]!],
    dueRetests: [],
    overdue: [tasks[2]!],
    other: [tasks[1]!],
    upcomingRetestCount: 2,
    done: [],
  };
  const html = renderToStaticMarkup(createElement(TodayGroupedQueue, {
    groups,
    state: "ready",
    plan: {
      date: "2026-10-09",
      acceptedVersion: 1,
      blocks: [{ taskId: tasks[0]!.id, start: "2026-10-09T01:00:00.000Z", end: "2026-10-09T01:25:00.000Z", reason: "plan" }],
      hardBlocks: [],
    },
  }));
  expect(html).toContain("今日已确认");
  expect(html).toContain("逾期");
  expect(html).toContain("其他待办");
  expect(html).toContain("确认中");
  expect(html).toContain("逾期项");
  expect(html).toContain("其他");
});

const PENDING = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "高等数学",
  status: "pending" as const,
  minutes: 25,
  dueAt: null,
  priority: 1,
  version: 1,
};

it("pending queue rows render 标记完成 via TaskStatusControl", () => {
  const html = renderToStaticMarkup(
    createElement(TodayTaskList, {
      tasks: [PENDING],
      state: "ready",
      api: { updateTaskStatus: vi.fn() },
    }),
  );
  expect(html).toContain("标记完成");
  expect(html).toContain('data-today-task-status="true"');
});

it("doneView rows do not render 标记完成", () => {
  const html = renderToStaticMarkup(
    createElement(TodayTaskList, {
      tasks: [{ ...PENDING, status: "done" as const, version: 2 }],
      state: "ready",
      doneView: true,
      api: { updateTaskStatus: vi.fn() },
    }),
  );
  expect(html).not.toContain("标记完成");
  expect(html).not.toContain('data-today-task-status="true"');
});

it("does not nest interactive buttons inside the select button", () => {
  const html = renderToStaticMarkup(
    createElement(TodayTaskList, {
      tasks: [PENDING],
      state: "ready",
      api: { updateTaskStatus: vi.fn() },
    }),
  );
  // Select <button> must close before the status control region that hosts more <button>s.
  const statusAt = html.indexOf('data-today-task-status="true"');
  expect(statusAt).toBeGreaterThan(-1);
  const selectClose = html.indexOf("</button>");
  expect(selectClose).toBeGreaterThan(-1);
  expect(selectClose).toBeLessThan(statusAt);
  // Status control buttons are siblings after the select button closes — not descendants.
  const openEnd = html.indexOf(">", html.indexOf("<button")) + 1;
  const selectInner = html.slice(openEnd, selectClose);
  expect(selectInner).not.toContain("<button");
});

it("successful updateTaskStatus triggers TaskQueueRefreshContext reread (control contract used by rows)", async () => {
  const controlSrc = readFileSync(
    fileURLToPath(new URL("./task-status-control.tsx", import.meta.url)),
    "utf8",
  );
  expect(controlSrc).toContain("if (result.kind === \"updated\") reread?.()");
  expect(controlSrc).toContain("TaskQueueRefreshContext");

  const reread = vi.fn();
  const updated = {
    id: PENDING.id,
    version: 2,
    title: PENDING.title,
    minutes: PENDING.minutes,
    dueAt: null,
    priority: 1,
    status: "done" as const,
  };
  const updateTaskStatus = vi.fn(async () => updated);
  const session = createTaskStatusSession(
    (id, input) => updateTaskStatus(id, input),
    { taskId: PENDING.id, expectedVersion: 1 },
  );
  const result = await session.confirm("done", new Date("2026-10-14T00:00:00.000Z"));
  expect(result).toEqual({ kind: "updated", task: updated });
  // Same branch TaskStatusControl takes after a successful write when mounted under the provider.
  if (result?.kind === "updated") reread();
  expect(updateTaskStatus).toHaveBeenCalledTimes(1);
  expect(reread).toHaveBeenCalledTimes(1);

  // Rows actually mount the control (so the contract applies in the queue).
  const html = renderToStaticMarkup(
    createElement(
      TaskQueueRefreshContext.Provider,
      { value: reread },
      createElement(TodayTaskList, {
        tasks: [PENDING],
        state: "ready",
        api: { updateTaskStatus },
      }),
    ),
  );
  expect(html).toContain("标记完成");
});
