import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskItem, TeachingActivitySummary } from "@aistudy/contracts";
import { ActivitySummaryContent } from "./activity-summary-card";
import { endTeachingActivity } from "./activity-end-control";

const summary: TeachingActivitySummary = { coveredBlockIds: [], skippedBlockIds: [], attempts: { total: 3, correct: 1, incorrect: 1, unverified: 1 }, openQuestions: ["还需要核对的题目"], taskId: null };

describe("learning completion", () => {
  it("renders a summary without asking to finish an unrelated task", () => {
    const api = { updateTaskStatus: vi.fn() };
    const html = renderToStaticMarkup(createElement(ActivitySummaryContent, { summary, task: null, api, onReread: vi.fn() }));
    expect(html).toContain("本次学习已结束");
    expect(html).toContain("尚未核对");
    expect(html).toContain("还需要核对的题目");
    expect(html).not.toContain("标记为完成？");
    expect(api.updateTaskStatus).not.toHaveBeenCalled();
  });
  it("asks about the linked task and never writes it during rendering", () => {
    const api = { updateTaskStatus: vi.fn() };
    const task = { id: "task-1", title: "矩阵练习", status: "pending", version: 2 } as TaskItem;
    const html = renderToStaticMarkup(createElement(ActivitySummaryContent, { summary: { ...summary, taskId: task.id }, task, api, onReread: vi.fn() }));
    expect(html).toContain("把「矩阵练习」标记为完成？");
    expect(html).toContain("标记完成");
    expect(api.updateTaskStatus).not.toHaveBeenCalled();
  });
  it("ends through the current activity version without completing a task", async () => {
    const activity = { id: "activity-1", status: "active", updatedAt: "2026-10-15T01:00:00.000Z" };
    const api = { getTeachingActivity: vi.fn().mockResolvedValue(activity), patchTeachingActivityStatus: vi.fn().mockResolvedValue({ ...activity, status: "completed" }), updateTaskStatus: vi.fn() };
    await endTeachingActivity(api, activity.id);
    expect(api.patchTeachingActivityStatus).toHaveBeenCalledWith(activity.id, { status: "completed", expectedUpdatedAt: activity.updatedAt });
    expect(api.updateTaskStatus).not.toHaveBeenCalled();
    api.getTeachingActivity.mockResolvedValue({ ...activity, status: "completed" });
    await endTeachingActivity(api, activity.id);
    expect(api.patchTeachingActivityStatus).toHaveBeenCalledTimes(1);
  });
});
