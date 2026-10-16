import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StudyTask } from "./study-task";
import { TaskLearningActionContext, TaskRowActions } from "./task-row-actions";

const task = { id: "task-1", title: "矩阵练习", status: "pending" } as StudyTask;
describe("task teaching action", () => {
  it("offers a separate explicit action without starting anything during row display", () => {
    const start = vi.fn();
    const html = renderToStaticMarkup(createElement(TaskLearningActionContext.Provider, { value: { start, busy: false } }, createElement(TaskRowActions, { task })));
    expect(html).toContain("开始任务主讲");
    expect(start).not.toHaveBeenCalled();
  });
  it("leaves finished and retest tasks on their existing flows", () => {
    for (const row of [{ ...task, status: "done" as const }, { ...task, retestOrigin: true }]) {
      const html = renderToStaticMarkup(createElement(TaskLearningActionContext.Provider, { value: { start: vi.fn(), busy: false } }, createElement(TaskRowActions, { task: row })));
      expect(html).toBe("");
    }
  });
  it("opens an accepted card-review suggestion in the card queue without creating teaching", () => {
    const start = vi.fn();
    const row = { ...task, origin: "planner" as const, suggestionKind: "review_cards" as const };
    const html = renderToStaticMarkup(createElement(TaskLearningActionContext.Provider, { value: { start, busy: false } }, createElement(TaskRowActions, { task: row })));
    expect(html).toContain('href="/opening/cards"');
    expect(html).toContain("开始卡片复习");
    expect(html).not.toContain("开始任务主讲");
    expect(start).not.toHaveBeenCalled();
  });
  it("keeps card reviews available when the teaching workspace is disabled", () => {
    const row = { ...task, origin: "planner" as const, suggestionKind: "review_cards" as const };
    const html = renderToStaticMarkup(createElement(TaskRowActions, { task: row }));
    expect(html).toContain('href="/opening/cards"');
  });
});
