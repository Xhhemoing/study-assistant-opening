import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpeningApiError } from "../client/api";
import { createTaskStatusAttempt, createTaskStatusSession, taskStatusNotice, taskStatusVersionBlock } from "./task-status-action";
import { isRetestOriginTask, TaskStatusControl, TaskStatusPanel } from "./task-status-control";

const taskId = "11111111-1111-4111-8111-111111111111";
const target = { taskId, expectedVersion: 3 };
const at = new Date("2026-10-08T09:00:00.000Z");
const updated = { id: taskId, version: 4, title: "复习矩阵", minutes: 25, dueAt: null, priority: 0, status: "done" as const };

describe("createTaskStatusAttempt", () => {
  it("sends exactly one write for one displayed task version and never resubmits after success", async () => {
    let finish!: (value: typeof updated) => void;
    const update = vi.fn(() => new Promise<typeof updated>(resolve => { finish = resolve; }));
    const attempt = createTaskStatusAttempt(update, target, "done", at);
    const first = attempt.confirm();
    await expect(attempt.confirm()).resolves.toBeNull();
    finish(updated);
    await expect(first).resolves.toEqual({ kind: "updated", task: updated });
    await expect(attempt.confirm()).resolves.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(taskId, { status: "done", expectedVersion: 3, at: "2026-10-08T09:00:00.000Z" });
  });

  it("locks an uncertain outcome without automatic or repeated submission", async () => {
    const update = vi.fn(async (): Promise<typeof updated> => { throw new TypeError("Network unavailable"); });
    const attempt = createTaskStatusAttempt(update, target, "skipped", at);
    await expect(attempt.confirm()).resolves.toEqual({ kind: "unknown" });
    await expect(attempt.confirm()).resolves.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(taskId, { status: "skipped", expectedVersion: 3, at: "2026-10-08T09:00:00.000Z" });
  });

  it("treats a 5xx response as an uncertain outcome", async () => {
    const update = vi.fn(async (): Promise<typeof updated> => { throw new OpeningApiError(500, "upstream failed"); });
    const attempt = createTaskStatusAttempt(update, target, "done", at);
    await expect(attempt.confirm()).resolves.toEqual({ kind: "unknown" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 409])("returns a definitive %s rejection without converting it into success", async status => {
    const update = vi.fn(async (): Promise<typeof updated> => { throw new OpeningApiError(status, "server detail"); });
    const attempt = createTaskStatusAttempt(update, target, "done", at);
    await expect(attempt.confirm()).resolves.toEqual({ kind: "rejected", status });
    await expect(attempt.confirm()).resolves.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("task status notices", () => {
  it("names a stale write without treating it as success or an automatic retry", () => {
    expect(taskStatusNotice({ kind: "rejected", status: 409 })).toBe("任务已更新，请重新读取");
    expect(taskStatusNotice({ kind: "unknown" })).toContain("核对");
    expect(taskStatusNotice({ kind: "unknown" })).toContain("不会自动重试");
    expect(taskStatusNotice({ kind: "rejected", status: 400 })).toBe("任务状态无法更新，请核对当前任务后再试。");
    expect(taskStatusNotice({ kind: "rejected", status: 404 })).toBe("这项任务已不存在或不可访问。");
    expect(taskStatusNotice({ kind: "rejected", status: 400 })).not.toBe(taskStatusNotice({ kind: "rejected", status: 404 }));
  });

  it("keeps complete and skip on one displayed version", async () => {
    let finish!: (value: typeof updated) => void;
    const update = vi.fn(() => new Promise<typeof updated>((resolve) => { finish = resolve; }));
    const session = createTaskStatusSession(update, target);
    const first = session.confirm("done", at);
    await expect(session.confirm("skipped", at)).resolves.toBeNull();
    finish(updated);
    await expect(first).resolves.toEqual({ kind: "updated", task: updated });
    await expect(session.confirm("skipped", at)).resolves.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(taskId, { status: "done", expectedVersion: 3, at: "2026-10-08T09:00:00.000Z" });
  });

  it("locks a 408 timeout as an uncertain outcome", async () => {
    const update = vi.fn(async (): Promise<typeof updated> => { throw new OpeningApiError(408, "timeout"); });
    const attempt = createTaskStatusAttempt(update, target, "done", at);
    await expect(attempt.confirm()).resolves.toEqual({ kind: "unknown" });
    await expect(attempt.confirm()).resolves.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("task status control", () => {
  const pending = { id: taskId, version: 3, title: "review", minutes: 25, dueAt: null, priority: 0, status: "pending" as const };

  it("offers complete and a separate skip confirmation without writing on render", () => {
    const updateTaskStatus = vi.fn();
    const html = renderToStaticMarkup(createElement(TaskStatusControl, { task: pending, api: { updateTaskStatus }, disabled: false }));
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(html).toContain("标记完成");
    expect(html).toContain("跳过");
    expect(html).not.toContain("确认跳过");
    expect(html).not.toContain('disabled=""');
    const confirming = renderToStaticMarkup(createElement(TaskStatusPanel, { task: pending, confirmingSkip: true }));
    expect(confirming).toContain("确认跳过");
    expect(confirming).toContain("再次确认");
    expect(confirming).not.toContain("标记完成");
  });

  it("shows only the terminal status and no rollback", () => {
    for (const status of ["done", "skipped"] as const) {
      const html = renderToStaticMarkup(createElement(TaskStatusPanel, { task: { status } }));
      expect(html).toContain(status === "done" ? "已完成" : "已跳过");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("标记完成");
    }
  });

  it("disables the actions when the displayed version is missing", () => {
    const html = renderToStaticMarkup(createElement(TaskStatusControl, {
      task: { ...pending, version: undefined },
      api: { updateTaskStatus: vi.fn() },
      disabled: false,
    }));
    expect(html).toContain(taskStatusVersionBlock(undefined));
    expect(html).toContain('disabled=""');
  });

  it("attaches the retest hint without inventing a retest request", () => {
    expect(isRetestOriginTask({})).toBe(false);
    expect(isRetestOriginTask({ retest: null })).toBe(false);
    expect(isRetestOriginTask({ retest: { candidateId: "x" } })).toBe(true);
    const updateTaskStatus = vi.fn();
    const html = renderToStaticMarkup(createElement(TaskStatusControl, { task: pending, api: { updateTaskStatus }, disabled: false, retestOrigin: true }));
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(html).toContain("建议先完成补测作答");
  });

  it("shows the stale-read alert and a read action that is not another status label", () => {
    const notice = taskStatusNotice({ kind: "rejected", status: 409 })!;
    const html = renderToStaticMarkup(createElement(TaskStatusPanel, { task: pending, notice, showReread: true }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(notice);
    expect(html).toContain("重新读取");
    expect(html).not.toContain("不会自动重试");
  });
});
