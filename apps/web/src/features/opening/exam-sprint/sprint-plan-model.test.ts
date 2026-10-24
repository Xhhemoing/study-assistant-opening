import { describe, expect, it } from "vitest";
import { taskCreateInputSchema, taskItemSchema, type TaskItem } from "@aistudy/contracts";
import { sprintTaskHref, sprintTodayTasks } from "./sprint-plan-model";

const courseId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const activityId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const task: TaskItem = { id: taskId, courseId, title: "矩阵讲练", minutes: 20, dueAt: null, priority: 1, status: "pending" };
const teachingTarget = { activityId, courseId, requirementKey: null };
const baseHref = `/opening/courses/${courseId}/study?task=${taskId}`;

describe("sprint task targets", () => {
  it("links the bound lesson while retaining task admission and lazy creation for unbound tasks", () => {
    expect(sprintTaskHref(task)).toBe(baseHref);
    expect(sprintTaskHref({ ...task, teachingTarget })).toBe(`${baseHref}&activity=${activityId}`);
    expect(sprintTaskHref({ ...task, requirementKey: "matrix:v1", teachingTarget: { ...teachingTarget, requirementKey: "matrix:v1" } }))
      .toBe(`${baseHref}&activity=${activityId}`);
    expect(sprintTaskHref({ ...task, teachingTarget: { ...teachingTarget, requirementKey: "matrix:v1" } }))
      .toBe(`${baseHref}&activity=${activityId}`);
    expect(sprintTaskHref({ ...task, requirementKey: null, teachingTarget: { ...teachingTarget, requirementKey: "matrix:v1" } }))
      .toBe(baseHref);
  });

  it.each([
    { ...teachingTarget, courseId: otherId },
    { ...teachingTarget, requirementKey: "old:v1" },
  ])("does not put a mismatched target into the navigation URL: %j", target => {
    expect(sprintTaskHref({ ...task, requirementKey: "matrix:v1", teachingTarget: target })).toBe(baseHref);
  });

  it("retains the card and course-less execution routes", () => {
    expect(sprintTaskHref({ ...task, suggestionKind: "review_cards", teachingTarget })).toBe("/opening/review?tab=cards");
    expect(sprintTaskHref({ ...task, courseId: undefined })).toBe(`/opening/settings/planning?task=${taskId}#task-${taskId}`);
  });

  it("does not make a deferred or closed task actionable just because its target is ready", () => {
    const now = new Date("2026-10-23T10:00:00.000Z");
    const block = { taskId, start: now.toISOString(), end: "2026-10-23T10:20:00.000Z", reason: "已确认计划" };
    for (const change of [{ notBefore: "2026-10-24T00:00:00.000Z" }, { status: "done" as const }, { status: "skipped" as const }]) {
      expect(sprintTodayTasks([{ ...task, teachingTarget, ...change }], [block], courseId, now)[0]?.actionable).toBe(false);
    }
    // dueAt is a deadline, not a start gate: overdue pending tasks remain reachable.
    expect(sprintTodayTasks([{ ...task, teachingTarget, dueAt: "2026-10-22T00:00:00.000Z" }], [block], courseId, now)[0]?.actionable).toBe(true);
  });

  it("accepts an optional read projection without letting task creation inject one", () => {
    expect(taskItemSchema.parse(task)).not.toHaveProperty("teachingTarget");
    expect(taskItemSchema.parse({ ...task, teachingTarget }).teachingTarget).toEqual(teachingTarget);
    for (const invalid of [{ ...teachingTarget, activityId: "not-a-uuid" }, { ...teachingTarget, courseId: "wrong" },
      { ...teachingTarget, requirementKey: undefined }, { ...teachingTarget, blockId: otherId }]) {
      expect(taskItemSchema.safeParse({ ...task, teachingTarget: invalid }).success).toBe(false);
    }
    const input = { title: task.title, minutes: task.minutes, dueAt: null, priority: 1, candidateId: null, courseId };
    expect(taskCreateInputSchema.safeParse(input).success).toBe(true);
    expect(taskCreateInputSchema.safeParse({ ...input, teachingTarget }).success).toBe(false);
  });
});
