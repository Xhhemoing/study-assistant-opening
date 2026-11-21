// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { teachingActivitySummarySchema, type TaskItem, type TeachingActivity, type TeachingActivitySummary } from "@aistudy/contracts";
import { ActivitySummaryContent } from "./activity-summary-card";
import { endTeachingActivity } from "./activity-end-control";
import { parseCourseStudyPracticeEntry } from "../courses/course-study-query";
import { MatrixExerciseForm } from "../learning/matrix-exercise-form";

const learningClient = vi.hoisted(() => ({ createSession: vi.fn(), createAttempt: vi.fn() }));
vi.mock("../client/learning-client", () => ({ createOpeningLearningClient: () => learningClient }));

const summary: TeachingActivitySummary = { coveredBlockIds: [], skippedBlockIds: [], attempts: { total: 3, correct: 1, incorrect: 1, unverified: 1 }, openQuestions: ["还需要核对的题目"], taskId: null };
const courseId = "11111111-1111-4111-8111-111111111111";
const observationId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const matrixPractice = { sourceId, exerciseKey: "addition", variant: 2 } as const;

function renderAssistedSummary(nextStep: unknown) {
  return renderToStaticMarkup(createElement(ActivitySummaryContent, {
    summary: teachingActivitySummarySchema.parse({ ...summary, nextStep }),
    task: null,
    api: { updateTaskStatus: vi.fn() },
    onReread: vi.fn(),
    activity: { courseId, status: "completed", sourceIds: [sourceId] } as TeachingActivity,
  }));
}

it("opens a same-source matrix exercise with the exact-check practice mode", () => {
  const html = renderAssistedSummary({
    kind: "assisted_check", observationId,
    matrixPractice,
  });
  expect(html).toContain(`href="/opening/courses/${courseId}/study?mode=matrix&amp;exercise=addition&amp;variant=2&amp;sourceId=${sourceId}"`);
  expect(html).toContain("独立试做同类题");
  expect(html).toContain("提交后自动核算");
});

it.each([true, false])("starts the linked source and variant only when the material is available (available=%s)", async boundSourceAvailable => {
  const exercise = { ...matrixPractice, variant: boundSourceAvailable ? 2 : 3 };
  const host = document.createElement("div");
  host.innerHTML = renderAssistedSummary({ kind: "assisted_check", observationId, matrixPractice: exercise });
  const href = new URL(host.querySelector("a")!.href);
  const { initialMatrixExercise } = parseCourseStudyPracticeEntry(Object.fromEntries(href.searchParams));
  expect(initialMatrixExercise).toEqual(exercise);
  if (!initialMatrixExercise) throw new Error("missing bound exercise");

  const destination = document.createElement("div");
  const root = createRoot(destination);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  learningClient.createSession.mockReset().mockResolvedValue({ id: courseId });
  learningClient.createAttempt.mockReset().mockRejectedValue(new Error("暂时无法创建练习"));
  try {
    await act(async () => root.render(createElement(MatrixExerciseForm, {
      courseId, boundExercise: initialMatrixExercise, boundSourceAvailable, onRecorded: vi.fn(),
    })));
    const start = destination.querySelector("form button");
    expect(start?.disabled).toBe(!boundSourceAvailable);
    expect(destination.querySelector("select")).toBeNull();
    if (boundSourceAvailable) {
      await act(async () => destination.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(learningClient.createSession).toHaveBeenCalledExactlyOnceWith({ courseId, sourceIds: [sourceId], skillLabel: "矩阵加法" });
      expect(learningClient.createAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ matrixExercise: exercise }));
      expect(destination.querySelector('[role="alert"]')).not.toBeNull();
    } else {
      expect(destination.querySelector('[role="alert"]')?.textContent).toContain("原课程材料暂不可用");
      expect(learningClient.createSession).not.toHaveBeenCalled();
      expect(learningClient.createAttempt).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("rejects a same-source practice URL missing its exercise identity", () => {
  expect(parseCourseStudyPracticeEntry({ mode: "matrix", sourceId })).toHaveProperty("practiceEntryError");
});

it("describes unbound course practice as a manual record even when the activity has material", () => {
  const html = renderAssistedSummary({ kind: "assisted_check", observationId });
  expect(html).toContain(`href="/opening/courses/${courseId}/study?mode=practice"`);
  expect(html).toContain("记录自选练习");
  expect(html).toContain("自己填写题目和作答结果");
  expect(html).not.toContain("独立试做同类题");
});

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
  it("shows status rather than a completion prompt for an already finished linked task", () => {
    const api = { updateTaskStatus: vi.fn() };
    const task = { id: "task-1", title: "矩阵练习", status: "done", version: 2 } as TaskItem;
    const html = renderToStaticMarkup(createElement(ActivitySummaryContent, { summary: { ...summary, taskId: task.id }, task, api, onReread: vi.fn() }));
    expect(html).toContain("关联任务「矩阵练习」");
    expect(html).toContain("已完成");
    expect(html).not.toContain("标记为完成？");
    expect(html).toContain("课程路线");
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
