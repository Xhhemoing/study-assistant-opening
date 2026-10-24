// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SprintBudgetResponse } from "@aistudy/contracts";
import { readSprintBudget, SprintBudgetPreview } from "./sprint-budget-preview";

const courseId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const result: SprintBudgetResponse = {
  courseId, generatedAt: "2026-10-23T00:00:00.000Z", status: "ready", examDate: "2026-10-30",
  timeZone: "Asia/Shanghai", dailyMinutes: 60, horizonTruncated: false,
  tasks: [{ id: taskId, title: "极限独立练习" }], days: [], scheduledTaskIds: [],
  unscheduled: [{ taskId, reason: "budget_exhausted" }], deferredTaskIds: [], warnings: ["不代表已确认安排"],
};
let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const click = async () => { await act(async () => host.querySelector("button")!.click()); };

describe("read-only sprint budget preview", () => {
  it("does not fetch on mount or StrictMode, only reads on explicit click", async () => {
    const load = vi.fn().mockResolvedValue(result);
    await act(async () => root.render(createElement(StrictMode, null, createElement(SprintBudgetPreview, { courseId, load }))));
    expect(load).not.toHaveBeenCalled(); await click();
    expect(load).toHaveBeenCalledTimes(1); expect(host.textContent).toContain("只读预估，尚未应用");
    expect(host.textContent).toContain("极限独立练习：课程时间预算不足");
    expect(host.textContent).not.toContain("已经学会");
  });
  it("suppresses concurrent reads and ignores late result after changing course", async () => {
    let finish!: (value: SprintBudgetResponse) => void;
    const load = vi.fn().mockImplementation(() => new Promise<SprintBudgetResponse>(resolve => { finish = resolve; }));
    await act(async () => root.render(createElement(SprintBudgetPreview, { courseId, load })));
    await act(async () => { host.querySelector("button")!.click(); host.querySelector("button")!.click(); });
    expect(load).toHaveBeenCalledTimes(1);
    const signal = load.mock.calls[0]![1] as AbortSignal;
    await act(async () => root.render(createElement(SprintBudgetPreview, { courseId: other, load })));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(result));
    expect(host.textContent).not.toContain("极限独立练习");
    expect(host.querySelector("button")!.disabled).toBe(false);
  });
  it("aborts an owned in-flight read on unmount", async () => {
    const load = vi.fn().mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(createElement(SprintBudgetPreview, { courseId, load }))); await click();
    const signal = load.mock.calls[0]![1] as AbortSignal;
    await act(async () => root.render(null)); expect(signal.aborted).toBe(true);
  });
  it("removes stale estimates when a refresh fails and remains retryable", async () => {
    const load = vi.fn().mockResolvedValueOnce(result).mockRejectedValueOnce(new Error("网络失败")).mockResolvedValue(result);
    await act(async () => root.render(createElement(SprintBudgetPreview, { courseId, load }))); await click(); await click();
    expect(host.textContent).toContain("网络失败"); expect(host.textContent).not.toContain("极限独立练习");
    await click(); expect(host.textContent).toContain("极限独立练习");
  });
  it.each(["needs_goal", "needs_settings", "invalid_settings", "deadline_reached"] as const)("shows %s without fabricated capacity", async status => {
    const load = vi.fn().mockResolvedValue({ ...result, status, tasks: [], unscheduled: [] });
    await act(async () => root.render(createElement(SprintBudgetPreview, { courseId, load }))); await click();
    expect(host.querySelector('[role="status"]')?.textContent).toBeTruthy();
    expect(host.textContent).not.toContain("新增可排");
  });
  it("marks a truncated horizon and empty task list without claiming mastery", async () => {
    const load = vi.fn().mockResolvedValue({ ...result, tasks: [], unscheduled: [], horizonTruncated: true });
    await act(async () => root.render(createElement(SprintBudgetPreview, { courseId, load }))); await click();
    expect(host.textContent).toContain("并非完整考前安排"); expect(host.textContent).toContain("不代表全部课程已经学会");
  });
});

describe("budget response boundary", () => {
  it("sends GET/no-store with cancellation and validates owned course identity", async () => {
    const request = vi.fn().mockResolvedValue(Response.json(result)); const signal = new AbortController().signal;
    expect(await readSprintBudget(courseId, signal, request)).toEqual(result);
    expect(request).toHaveBeenCalledWith(`/api/opening/courses/${courseId}/sprint-budget`, { method: "GET", cache: "no-store", signal });
    request.mockResolvedValue(Response.json({ ...result, courseId: other }));
    await expect(readSprintBudget(courseId, signal, request)).rejects.toThrow("课程已变化");
  });
  it("accepts the canonical response to an uppercase course UUID", async () => {
    const id = "a1111111-1111-4111-8111-111111111111";
    const request = vi.fn().mockResolvedValue(Response.json({ ...result, courseId: id }));
    expect((await readSprintBudget(id.toUpperCase(), new AbortController().signal, request)).courseId).toBe(id);
  });
  it("rejects server errors and malformed estimates", async () => {
    const request = vi.fn().mockResolvedValueOnce(Response.json({ secret: "do not display" }, { status: 500 })).mockResolvedValueOnce(Response.json({ courseId }));
    const signal = new AbortController().signal;
    await expect(readSprintBudget(courseId, signal, request)).rejects.toThrow("当前正式安排没有改变");
    await expect(readSprintBudget(courseId, signal, request)).rejects.toThrow("无法核验");
  });
});
