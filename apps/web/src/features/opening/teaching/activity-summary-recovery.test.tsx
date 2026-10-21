// @vitest-environment jsdom
import { act, createElement, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskItem, TeachingActivitySummary } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";

const { getSummary } = vi.hoisted(() => ({ getSummary: vi.fn() }));
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
