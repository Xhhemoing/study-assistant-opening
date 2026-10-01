import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpeningApiError } from "../client/api";
import { createTaskReminderAttempt, TaskReminder, TaskReminderStatus } from "./task-reminder";

const task = { id: "11111111-1111-4111-8111-111111111111", title: "复习矩阵", status: "pending" as const, version: 3 };
const reminder = { id: "22222222-2222-4222-8222-222222222222", taskId: task.id, taskVersion: 3, dueAt: "2026-09-29T12:00:00.000Z", channel: "in_app" as const, status: "due" as const, receiptId: null, outcome: null };
const target = { taskId: task.id, expectedVersion: task.version };

describe("explicit one-task in-app reminder", () => {
  it("does not write while previewing and explains this action's exact scope", () => {
    const requestTaskReminder = vi.fn();
    const html = renderToStaticMarkup(createElement(TaskReminder, { task, api: { requestTaskReminder }, disabled: false }));
    expect(requestTaskReminder).not.toHaveBeenCalled();
    expect(html).toContain("仅本次到期提醒");
    expect(html).toContain("不更改");
    expect(html).toContain("本操作不发送外部推送");
    expect(html).toContain("加入应用内提醒");
    expect(html).not.toContain("已发送");
  });

  it.each([
    [{ ...task, version: undefined }, "版本"],
    [{ ...task, status: "done" as const }, "待办"],
    [{ ...task, status: "skipped" as const }, "待办"],
  ])("disables unavailable task intent %j without guessing a version", (value, reason) => {
    const html = renderToStaticMarkup(createElement(TaskReminder, { task: value, api: { requestTaskReminder: vi.fn() }, disabled: false }));
    expect(html).toContain('disabled=""');
    expect(html).toContain(reason);
  });

  it("uses the displayed task/version once and prevents concurrent or repeated confirmation", async () => {
    let finish!: (value: { reminders: typeof reminder[] }) => void;
    const request = vi.fn(() => new Promise<{ reminders: typeof reminder[] }>(resolve => { finish = resolve; }));
    const attempt = createTaskReminderAttempt(request, target, () => "reminder-test-1");
    const first = attempt.confirm();
    await expect(attempt.confirm()).resolves.toBeNull();
    finish({ reminders: [reminder] });
    await expect(first).resolves.toEqual({ kind: "queued" });
    await expect(attempt.confirm()).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ ...target, channel: "in_app", clientKey: "reminder-test-1" });
  });

  it.each([new TypeError("Network unavailable"), new OpeningApiError(500, "upstream failed"), new OpeningApiError(408, "timeout")])("locks an uncertain result without automatic or repeated submission", async error => {
    const request = vi.fn(async () => { throw error; });
    const attempt = createTaskReminderAttempt(request, target, () => "reminder-test-1");
    await expect(attempt.confirm()).resolves.toEqual({ kind: "unknown" });
    await expect(attempt.confirm()).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([404, 409, 422])("shows actionable %s without converting rejection into success", async status => {
    const request = vi.fn(async () => { throw new OpeningApiError(status, "server detail"); });
    const result = await createTaskReminderAttempt(request, target, () => "reminder-test-1").confirm();
    expect(result).toMatchObject({ kind: "rejected", status });
    const html = renderToStaticMarkup(createElement(TaskReminderStatus, { state: result! }));
    expect(html).toContain('role="alert"');
    expect(html).toContain(status === 409 ? "任务已更新" : status === 404 ? "不可访问" : "尚未到期");
    expect(html).not.toContain("已加入");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("only retries a definitive rejection on another explicit confirmation with the same idempotency key", async () => {
    const request = vi.fn().mockRejectedValueOnce(new OpeningApiError(422, "not due")).mockResolvedValueOnce({ reminders: [reminder] });
    const attempt = createTaskReminderAttempt(request, target, () => "reminder-test-1");
    await expect(attempt.confirm()).resolves.toMatchObject({ kind: "rejected" });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(attempt.confirm()).resolves.toEqual({ kind: "queued" });
    expect(request.mock.calls[1]?.[0]).toEqual(request.mock.calls[0]?.[0]);
  });

  it("announces pending and queued in-app state without claiming external delivery", () => {
    expect(renderToStaticMarkup(createElement(TaskReminderStatus, { state: { kind: "pending" } }))).toContain("正在请求");
    const html = renderToStaticMarkup(createElement(TaskReminderStatus, { state: { kind: "queued" } }));
    expect(html).toContain("已加入应用内提醒");
    expect(html).not.toMatch(/已发送|已送达/);
    expect(renderToStaticMarkup(createElement(TaskReminderStatus, { state: { kind: "unknown" } }))).toContain("不会自动重试");
  });
});
