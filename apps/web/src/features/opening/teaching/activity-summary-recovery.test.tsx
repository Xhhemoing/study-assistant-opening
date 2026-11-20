// @vitest-environment jsdom
import { act, createElement, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskItem, TeachingActivity, TeachingActivitySummary } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";

const { getSummary } = vi.hoisted(() => ({ getSummary: vi.fn() }));
const routeClient = vi.hoisted(() => ({ read: vi.fn(), next: vi.fn(), scheduleRetest: vi.fn() }));
vi.mock("../courses/course-route-client", async importOriginal => ({
  ...await importOriginal<typeof import("../courses/course-route-client")>(),
  createCourseRouteClient: () => routeClient,
}));
vi.mock("./activity-client", () => ({ createTeachingActivityClient: () => ({ getSummary }) }));
vi.mock("../planning/task-status-control", async () => {
  const { createContext } = await import("react");
  const TaskQueueRefreshContext = createContext<(() => void) | null>(null);
  return { TaskQueueRefreshContext, TaskStatusControl: ({ task }: { task: TaskItem }) => {
    const refresh = useContext(TaskQueueRefreshContext);
    return createElement("button", { onClick: refresh, "data-task-id": task.id }, "重新核对");
  } };
});
import { ActivitySummaryCard } from "./activity-summary-card";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function summary(label: string, taskId: string | null = null): TeachingActivitySummary {
  return { coveredBlockIds: [], skippedBlockIds: [], attempts: { total: 1, correct: 0, incorrect: 0, unverified: 1 }, openQuestions: [label], taskId };
}
const task = (id: string) => ({ id, title: `任务 ${id}`, status: "pending", version: 1 }) as TaskItem;
let container: HTMLDivElement, root: Root;
let api: OpeningApi;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); getSummary.mockReset();
  api = { listTasks: vi.fn().mockResolvedValue({ tasks: [] }), updateTaskStatus: vi.fn() } as unknown as OpeningApi;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(activityId: string) { await act(async () => root.render(createElement(ActivitySummaryCard, { activityId, api }))); }

it.each([
  ["assisted_check", "独立试做同类题", "next", false],
  ["assisted_check", "独立试做同类题", "next", true],
  ["schedule_retest", "确认延迟复测安排", "scheduleRetest", false],
  ["schedule_retest", "确认延迟复测安排", "scheduleRetest", true],
] as const)("offers and submits %s via %s (%s, task lookup fails: %s)", async (kind, label, action, taskLookupFails) => {
  sessionStorage.clear();
  vi.clearAllMocks();
  const activityId = "11111111-1111-4111-8111-111111111111";
  const courseId = "22222222-2222-4222-8222-222222222222";
  const observationId = "33333333-3333-4333-8333-333333333333";
  const activity = { id: activityId, courseId, routeManaged: true, status: "completed", pathVersion: 2 } as TeachingActivity;
  const linkedTask = task("linked-task");
  getSummary.mockResolvedValue({ ...summary("已完成", linkedTask.id), nextStep: { kind, observationId } });
  if (taskLookupFails) vi.mocked(api.listTasks).mockRejectedValueOnce(new Error("任务暂时无法读取"));
  else vi.mocked(api.listTasks).mockResolvedValue({ tasks: [linkedTask] });
  routeClient.read.mockResolvedValue({ currentActivity: activity, currentRoute: { goalId: courseId, goalRevision: 1 }, observationId });
  routeClient.next.mockResolvedValue({ kind: "choice", href: "/opening/courses", message: "请确认课程路线" });
  routeClient.scheduleRetest.mockResolvedValue({ href: "/opening/review", notBeforeAt: "2026-11-23T00:00:00Z", taskStatus: "pending", retestStatus: "accepted" });
  await act(async () => root.render(createElement(ActivitySummaryCard, { activityId, activity, api })));
  const card = container.querySelector('[aria-label="本次学习小结"]');
  expect(card).not.toBeNull();
  expect(card?.textContent).toContain(taskLookupFails ? "关联任务当前不可用" : linkedTask.title);
  const buttons = [...card!.querySelectorAll("button")].filter(button => button.dataset.taskId === undefined);
  expect(buttons.map(button => button.textContent)).toEqual([label]);
  expect(routeClient.read).not.toHaveBeenCalled();
  expect(routeClient.next).not.toHaveBeenCalled();
  expect(routeClient.scheduleRetest).not.toHaveBeenCalled();
  await act(async () => buttons[0]!.click());
  expect(routeClient[action]).toHaveBeenCalledExactlyOnceWith(courseId, expect.objectContaining({ activityId, observationId }));
  expect(routeClient[action === "next" ? "scheduleRetest" : "next"]).not.toHaveBeenCalled();
});

it("hides the previous activity immediately and ignores its late summary", async () => {
  const old = deferred<TeachingActivitySummary>(); getSummary.mockReturnValueOnce(old.promise).mockResolvedValueOnce(summary("当前活动"));
  await render("old"); await render("current");
  expect(container.textContent).toContain("当前活动");
  await act(async () => old.resolve(summary("旧活动", "old-task")));
  expect(container.textContent).not.toContain("旧活动"); expect(api.listTasks).not.toHaveBeenCalled();
});

it("keeps summary and linked task atomic across activity changes", async () => {
  const tasks = deferred<{ tasks: TaskItem[] }>();
  getSummary.mockResolvedValueOnce(summary("旧小结", "old-task")).mockResolvedValueOnce(summary("新小结", "new-task"));
  vi.mocked(api.listTasks).mockResolvedValueOnce({ tasks: [task("old-task")] }).mockReturnValueOnce(tasks.promise);
  await render("old"); expect(container.querySelector('[data-task-id="old-task"]')).not.toBeNull();
  await render("new"); expect(container.textContent).not.toContain("旧小结"); expect(container.textContent).not.toContain("新小结");
  expect(container.querySelector("[data-task-id]")).toBeNull();
  await act(async () => tasks.resolve({ tasks: [task("new-task")] }));
  expect(container.textContent).toContain("新小结"); expect(container.querySelector('[data-task-id="new-task"]')).not.toBeNull();
});

it("ignores an older reread of the same activity, including its task response", async () => {
  const olderTasks = deferred<{ tasks: TaskItem[] }>();
  getSummary.mockResolvedValueOnce(summary("初始", "task")).mockResolvedValueOnce(summary("较旧读取", "task")).mockResolvedValueOnce(summary("最新读取", "task"));
  vi.mocked(api.listTasks).mockResolvedValueOnce({ tasks: [task("task")] }).mockReturnValueOnce(olderTasks.promise).mockResolvedValueOnce({ tasks: [task("task")] });
  await render("same");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).toContain("最新读取");
  await act(async () => olderTasks.resolve({ tasks: [] }));
  expect(container.textContent).toContain("最新读取"); expect(container.textContent).not.toContain("较旧读取");
  expect(container.querySelector('[data-task-id="task"]')).not.toBeNull();
});

it("does not replace a current activity with an old request failure", async () => {
  const old = deferred<TeachingActivitySummary>(); getSummary.mockReturnValueOnce(old.promise).mockResolvedValueOnce(summary("当前活动"));
  await render("old"); await render("current");
  await act(async () => old.reject(new Error("旧请求失败")));
  expect(container.textContent).toContain("当前活动"); expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("hides the loading indicator when summary reading fails and retries cleanly", async () => {
  getSummary.mockRejectedValueOnce(new Error("小结暂不可读")).mockResolvedValueOnce(summary("恢复后的小结"));
  await render("same");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("小结暂不可读");
  expect(container.textContent).not.toContain("正在读取学习小结…");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(container.textContent).toContain("恢复后的小结");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
