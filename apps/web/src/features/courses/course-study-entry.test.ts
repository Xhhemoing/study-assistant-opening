import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskItem, TeachingActivity } from "@aistudy/contracts";
import { openCourseStudy } from "./course-study-entry";
import { buildCourseStudyInput, courseActivityNextStep, courseStudyTasks, currentCourseActivity } from "./course-study-model";
import { CourseRetestReview } from "./course-study-workspace";

const courseId = "11111111-1111-4111-8111-111111111111";
const otherCourseId = "22222222-2222-4222-8222-222222222222";
const activityId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
function activity(overrides: Partial<TeachingActivity> = {}): TeachingActivity {
  return { id: activityId, courseId, workspaceId: courseId, ownerUserId: courseId, status: "active", generateStatus: "ready", intentKind: "topic", intentSummary: "矩阵", sourceIds: [], pathVersion: 1, contentVersion: 1, clientKey: `course-study:${courseId}:first`, createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z", ...overrides };
}
function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return { id: taskId, courseId, title: "矩阵任务", minutes: 20, dueAt: null, priority: 1, status: "pending", ...overrides };
}
const options = { courseId, courseTitle: "线性代数", compilerEnabled: true, archived: false, sourceIds: [] };
function api(rows: TeachingActivity[] = []) {
  return { getTeachingActivity: vi.fn(async () => rows[0]!), listTeachingActivities: vi.fn(async () => rows), listTasks: vi.fn(async () => ({ tasks: [] as TaskItem[] })), createTeachingActivity: vi.fn(async () => activity({ generateStatus: "queued", contentVersion: 0 })) };
}

describe("course study entry", () => {
  it("continues A despite a more recent B and restores queued activities without creating another", async () => {
    const current = activity({ generateStatus: "generating" });
    const client = api([activity({ id: otherCourseId, courseId: otherCourseId, updatedAt: "2026-10-18T00:00:00Z" }), current]);
    expect(await openCourseStudy(client, options)).toEqual({ kind: "activity", activity: current });
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });
  it("refuses mismatched and missing explicit activities without creating a replacement", async () => {
    const client = api([activity({ courseId: otherCourseId })]);
    await expect(openCourseStudy(client, { ...options, activityId })).rejects.toThrow("不属于本课程");
    client.getTeachingActivity.mockRejectedValueOnce(new Error("not found"));
    await expect(openCourseStudy(client, { ...options, activityId })).rejects.toThrow("not found");
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });
  it.each(["failed", "cancelled", "unknown", "stale", "needs_check"] as const)("retains the %s activity and exposes a recoverable next step", async generateStatus => {
    const existing = activity({ generateStatus });
    const client = api([existing]);
    expect(await openCourseStudy(client, options)).toEqual({ kind: "activity", activity: existing });
    expect(courseActivityNextStep(existing)).not.toBe("");
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });
  it.each(["completed", "skipped"] as const)("starts a new course-specific chain after %s", async status => {
    const client = api([activity({ status })]);
    await openCourseStudy(client, options);
    expect(client.createTeachingActivity).toHaveBeenCalledWith(expect.objectContaining({ courseId, clientKey: `course-study:${courseId}:${activityId}`, createIntent: { source: "course", intentKind: "topic", courseId, afterActivityId: activityId } }));
  });
  it("supports empty courses without a goal and scopes idempotency to the course", async () => {
    const a = buildCourseStudyInput(courseId, "线代", [], []);
    const b = buildCourseStudyInput(otherCourseId, "微积分", [], []);
    expect(a.clientKey).not.toBe(b.clientKey);
    expect(a.createIntent).not.toEqual(b.createIntent);
    const client = api();
    await openCourseStudy(client, options);
    expect(client.createTeachingActivity).toHaveBeenCalledOnce();
  });
  it("ignores an empty legacy shell but preserves compiled legacy course progress", () => {
    expect(currentCourseActivity([activity({ intentKind: "course_continue", contentVersion: 0 })], courseId)).toBeNull();
    expect(currentCourseActivity([activity({ intentKind: "course_continue", contentVersion: 2 })], courseId)?.contentVersion).toBe(2);
  });
  it("keeps archived courses read-only and never calls teaching routes when the feature is off", async () => {
    const archived = api();
    expect(await openCourseStudy(archived, { ...options, archived: true, activityId })).toEqual({ kind: "practice" });
    expect(archived.getTeachingActivity).not.toHaveBeenCalled();
    expect(archived.createTeachingActivity).not.toHaveBeenCalled();
    const disabled = api();
    expect(await openCourseStudy(disabled, { ...options, teachingEnabled: false, activityId })).toEqual({ kind: "practice" });
    expect(disabled.listTeachingActivities).not.toHaveBeenCalled();
    expect(disabled.createTeachingActivity).not.toHaveBeenCalled();
  });
  it("uses independent practice when compilation is off", async () => {
    const client = api();
    expect(await openCourseStudy(client, { ...options, compilerEnabled: false })).toEqual({ kind: "practice" });
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });
  it("rejects foreign, closed and deferred task selection before creating", async () => {
    for (const selected of [task({ courseId: otherCourseId }), task({ status: "done" }), task({ notBefore: "2099-10-17T00:00:00.000Z" })]) {
      const client = api(); client.listTasks.mockResolvedValue({ tasks: [selected] });
      await expect(openCourseStudy(client, { ...options, taskId })).rejects.toThrow("重新选择");
      expect(client.createTeachingActivity).not.toHaveBeenCalled();
    }
  });
  it.each([{ taskId }, { retestId: courseId }])("rechecks a retest moved to the future before opening an existing activity: %j", async query => {
    const selected = task({ retest: { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "独立计算", recommendedAt: "2099-10-17T00:00:00.000Z" } });
    const client = api([activity({ clientKey: `task:${taskId}` })]);
    client.listTasks.mockResolvedValue({ tasks: [selected] });
    await expect(openCourseStudy(client, { ...options, ...query })).rejects.toThrow("尚未到开始时间");
    expect(client.listTeachingActivities).not.toHaveBeenCalled();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });
  it("requires both retest recommendation and deferral to be due, allowing the exact boundary", () => {
    const now = new Date("2026-10-21T12:00:00.000Z");
    const selected = task({ retest: { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "独立计算", recommendedAt: now.toISOString() }, notBefore: now.toISOString() });
    expect(courseStudyTasks([selected], courseId, now)).toEqual([selected]);
    expect(courseStudyTasks([{ ...selected, notBefore: "2026-10-22T00:00:00.000Z" }], courseId, now)).toEqual([]);
    expect(courseStudyTasks([{ ...selected, retest: { ...selected.retest!, recommendedAt: "2026-10-22T00:00:00.000Z" } }], courseId, now)).toEqual([]);
  });
  it.each(["cards", "practice"] as const)("uses the existing %s execution flow instead of generating a lecture", async kind => {
    const selected = kind === "cards" ? task({ suggestionKind: "review_cards" }) : task({ retest: { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "独立计算", recommendedAt: null } });
    const client = api(); client.listTasks.mockResolvedValue({ tasks: [selected] });
    expect(await openCourseStudy(client, { ...options, taskId })).toEqual({ kind, task: selected });
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });
  it("preserves retest linkage with teaching disabled", async () => {
    const selected = task({ retest: { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "独立计算", recommendedAt: null } });
    const client = api(); client.listTasks.mockResolvedValue({ tasks: [selected] });
    expect(await openCourseStudy(client, { ...options, teachingEnabled: false, retestId: courseId })).toEqual({ kind: "practice", task: selected });
    expect(client.listTeachingActivities).not.toHaveBeenCalled();
  });
  it.each([
    { teachingEnabled: true, query: { taskId } },
    { teachingEnabled: false, query: { taskId } },
    { teachingEnabled: true, query: { retestId: courseId } },
    { teachingEnabled: false, query: { retestId: courseId } },
  ])("returns completed retest context without teaching calls for $query and teaching=$teachingEnabled", async ({ teachingEnabled, query }) => {
    const selected = task({ status: "done", retest: { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "原补测题干", recommendedAt: null } });
    const client = api(); client.listTasks.mockResolvedValue({ tasks: [selected] });
    expect(await openCourseStudy(client, { ...options, teachingEnabled, ...query })).toEqual({ kind: "retest-review", task: selected });
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
    expect(client.getTeachingActivity).not.toHaveBeenCalled();
    expect(client.listTeachingActivities).not.toHaveBeenCalled();
  });
  it("rejects foreign, mismatched and skipped completed-retest links", async () => {
    const retest = { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "原补测题干", recommendedAt: null };
    for (const selected of [task({ status: "done", courseId: otherCourseId, retest }), task({ status: "done", retest: { ...retest, courseId: otherCourseId } }), task({ status: "skipped", retest })]) {
      const client = api(); client.listTasks.mockResolvedValue({ tasks: [selected] });
      await expect(openCourseStudy(client, { ...options, retestId: courseId })).rejects.toThrow("重新选择");
      expect(client.createTeachingActivity).not.toHaveBeenCalled();
      expect(client.listTeachingActivities).not.toHaveBeenCalled();
    }
  });
  it("renders completed retest as a review with its real prompt and course history link", () => {
    const selected = { ...task({ status: "done" }), retest: { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "原补测题干", recommendedAt: null } };
    const html = renderToStaticMarkup(createElement(CourseRetestReview, { courseId, task: selected }));
    expect(html).toContain("补测已完成 · 只读回顾");
    expect(html).toContain("原补测题干");
    expect(html).toContain(`/opening/courses/${courseId}#course-learning-records`);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("开始学习");
  });
  it("uses the server-owned task identity and preserves multiple choices", async () => {
    const tasks = [task(), task({ id: otherCourseId, priority: 2 })];
    expect(courseStudyTasks(tasks, courseId).map(row => row.id)).toEqual([otherCourseId, taskId]);
    const client = api(); client.listTasks.mockResolvedValue({ tasks });
    await openCourseStudy(client, { ...options, taskId });
    expect(client.createTeachingActivity).toHaveBeenCalledWith(expect.objectContaining({ courseId, clientKey: `task:${taskId}`, createIntent: { intentKind: "goal", source: "task", taskId } }));
  });
  it("refuses an existing task activity with a known different requirement", async () => {
    const existing = activity({ clientKey: `task:${taskId}`, learnerFocus: { skillLabel: "矩阵", requirementKey: "old", activityKind: "diagnose", reasonCode: "first", focusObservationId: null, recentAssistance: [], strategyVersion: "test" } });
    const client = api([existing]); client.listTasks.mockResolvedValue({ tasks: [task({ requirementKey: "new", teachingTarget: { activityId, courseId, requirementKey: "old" } })] });
    await expect(openCourseStudy(client, { ...options, taskId })).rejects.toThrow("学习要求已调整");
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });
});

describe("task-bound direct activity entry", () => {
  const teachingTarget = { activityId, courseId, requirementKey: null };
  const direct = { ...options, taskId, activityId };
  const focus = { skillLabel: "矩阵", requirementKey: "matrix:v1", activityKind: "diagnose" as const,
    reasonCode: "first", focusObservationId: null, recentAssistance: [], strategyVersion: "test" };

  it.each([
    undefined, task({ courseId: otherCourseId }), task({ status: "done" }), task({ status: "skipped" }),
    task({ notBefore: "2099-10-17T00:00:00.000Z" }),
    task({ retest: { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "补测",
      recommendedAt: "2099-10-17T00:00:00.000Z" } }),
  ])("validates current task admission before the explicit activity: %j", async selected => {
    const client = api([activity()]);
    client.listTasks.mockResolvedValue({ tasks: selected ? [{ ...selected, teachingTarget }] : [] });
    await expect(openCourseStudy(client, direct)).rejects.toThrow("重新选择");
    expect(client.getTeachingActivity).not.toHaveBeenCalled();
    expect(client.listTeachingActivities).not.toHaveBeenCalled();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });

  it.each([{}, { activityId }])("uses the authoritative target, including non-task onboarding keys, without listing or creating: %j", async query => {
    const existing = activity({ clientKey: `first-learning:${courseId}:activity`, status: "paused" });
    const client = api([existing]); client.listTasks.mockResolvedValue({ tasks: [task({ teachingTarget })] });
    expect(await openCourseStudy(client, { ...options, taskId, compilerEnabled: false, ...query })).toEqual({ kind: "activity", activity: existing });
    expect(client.getTeachingActivity).toHaveBeenCalledExactlyOnceWith(activityId);
    expect(client.listTasks.mock.invocationCallOrder[0]).toBeLessThan(client.getTeachingActivity.mock.invocationCallOrder[0]!);
    expect(client.listTeachingActivities).not.toHaveBeenCalled();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });

  it.each([
    undefined, { ...teachingTarget, activityId: otherCourseId }, { ...teachingTarget, courseId: otherCourseId },
  ])("rejects missing/changed/mismatched projections even when a client key looks bound: %j", async target => {
    const client = api([activity({ clientKey: `task:${taskId}` })]);
    client.listTasks.mockResolvedValue({ tasks: [task({ teachingTarget: target })] });
    await expect(openCourseStudy(client, direct)).rejects.toThrow("目标已变化");
    expect(client.getTeachingActivity).not.toHaveBeenCalled();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });

  it.each([null, "old"])("rejects a missing or changed projected requirement (%s) before loading content", async requirementKey => {
    const client = api([activity({ learnerFocus: focus })]);
    client.listTasks.mockResolvedValue({ tasks: [task({ requirementKey: "matrix:v1", teachingTarget: { ...teachingTarget, requirementKey } })] });
    await expect(openCourseStudy(client, direct)).rejects.toThrow("学习要求已调整");
    expect(client.getTeachingActivity).not.toHaveBeenCalled();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });

  it.each([
    { id: otherCourseId }, { courseId: otherCourseId }, { status: "completed" as const }, { status: "skipped" as const },
    { learnerFocus: { skillLabel: "矩阵", requirementKey: "old", activityKind: "diagnose" as const,
      reasonCode: "first", focusObservationId: null, recentAssistance: [], strategyVersion: "test" } },
  ])("rechecks the fetched activity rather than trusting the projection snapshot: %j", async change => {
    const client = api([activity(change)]); client.listTasks.mockResolvedValue({ tasks: [task({ teachingTarget })] });
    await expect(openCourseStudy(client, direct)).rejects.toThrow();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });

  it("requires the loaded activity's exact requirement and never falls back after a failed read", async () => {
    const selected = task({ requirementKey: "matrix:v1", teachingTarget: { ...teachingTarget, requirementKey: "matrix:v1" } });
    const client = api([activity()]); client.listTasks.mockResolvedValue({ tasks: [selected] });
    await expect(openCourseStudy(client, direct)).rejects.toThrow("学习要求已调整");
    client.getTeachingActivity.mockResolvedValueOnce(activity({ learnerFocus: focus }));
    expect((await openCourseStudy(client, direct)).kind).toBe("activity");
    client.getTeachingActivity.mockRejectedValueOnce(new Error("目标读取失败"));
    await expect(openCourseStudy(client, direct)).rejects.toThrow("目标读取失败");
    client.listTasks.mockRejectedValueOnce(new Error("任务读取失败"));
    await expect(openCourseStudy(client, direct)).rejects.toThrow("任务读取失败");
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });

  it("keeps teaching disabled and non-teaching task routes free of activity reads", async () => {
    const client = api([activity()]); client.listTasks.mockResolvedValue({ tasks: [task({ teachingTarget })] });
    expect(await openCourseStudy(client, { ...direct, teachingEnabled: false })).toEqual({ kind: "practice", task: task({ teachingTarget }) });
    client.listTasks.mockResolvedValue({ tasks: [task({ teachingTarget, suggestionKind: "review_cards" })] });
    await expect(openCourseStudy(client, direct)).rejects.toThrow("目标已变化");
    expect(client.getTeachingActivity).not.toHaveBeenCalled();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });

  it("keeps legacy unbound requirements usable while rejecting explicit null versus a concrete requirement", async () => {
    const client = api([activity({ learnerFocus: focus })]);
    const target = { ...teachingTarget, requirementKey: "matrix:v1" };
    client.listTasks.mockResolvedValue({ tasks: [task({ teachingTarget: target })] });
    expect((await openCourseStudy(client, direct)).kind).toBe("activity");
    client.getTeachingActivity.mockClear();
    client.listTasks.mockResolvedValue({ tasks: [task({ teachingTarget: target, requirementKey: null })] });
    await expect(openCourseStudy(client, direct)).rejects.toThrow("学习要求已调整");
    expect(client.getTeachingActivity).not.toHaveBeenCalled();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });

  it("does not let an activity or a second selector bypass retest identity and completion", async () => {
    const retest = { candidateId: courseId, activityId, courseId, skillLabel: "矩阵", prompt: "补测", recommendedAt: null };
    const client = api([activity()]); client.listTasks.mockResolvedValue({ tasks: [task({ retest, status: "done" })] });
    expect(await openCourseStudy(client, direct)).toMatchObject({ kind: "retest-review" });
    await expect(openCourseStudy(client, { ...direct, retestId: otherCourseId })).rejects.toThrow("重新选择");
    client.listTasks.mockResolvedValue({ tasks: [task({ retest: { ...retest, requirementKey: "old" }, requirementKey: "new" })] });
    await expect(openCourseStudy(client, direct)).rejects.toThrow("学习要求已调整");
    expect(client.getTeachingActivity).not.toHaveBeenCalled();
    expect(client.createTeachingActivity).not.toHaveBeenCalled();
  });
});
