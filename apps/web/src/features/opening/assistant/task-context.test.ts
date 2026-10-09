import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskContext } from "./task-context";

const courseId = "33333333-3333-4333-8333-333333333333";
const candidateId = "11111111-1111-4111-8111-111111111111";
const api = { requestTaskReminder: vi.fn(), updateTaskStatus: vi.fn() };

describe("TaskContext retest entry", () => {
  it("shows 开始补测 for a due retest task linking to course practice", () => {
    const task = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "补测任务",
      minutes: 20,
      dueAt: null,
      priority: 1,
      status: "pending" as const,
      version: 1,
      retest: {
        candidateId,
        activityId: "44444444-4444-4444-8444-444444444444",
        courseId,
        skillLabel: "分数",
        prompt: "再做一遍",
        recommendedAt: "2026-10-08T00:00:00.000Z",
      },
    };
    const html = renderToStaticMarkup(createElement(TaskContext, { task, api, disabled: false, onPrompt: () => undefined }));
    expect(html).toContain("开始补测");
    expect(html).toContain(`/opening/courses/${courseId}?retest=${candidateId}#course-practice`);
  });

  it("hides 开始补测 for ordinary tasks and future retests", () => {
    const ordinary = {
      id: "22222222-2222-4222-8222-222222222222",
      title: "普通",
      minutes: 20,
      dueAt: null,
      priority: 1,
      status: "pending" as const,
      version: 1,
      retest: null,
    };
    expect(renderToStaticMarkup(createElement(TaskContext, { task: ordinary, api, disabled: false, onPrompt: () => undefined }))).not.toContain("开始补测");
    const future = {
      ...ordinary,
      retest: {
        candidateId,
        activityId: "44444444-4444-4444-8444-444444444444",
        courseId,
        skillLabel: "分数",
        prompt: "稍后",
        recommendedAt: "2099-01-01T00:00:00.000Z",
      },
    };
    expect(renderToStaticMarkup(createElement(TaskContext, { task: future, api, disabled: false, onPrompt: () => undefined }))).not.toContain("开始补测");
  });
});
