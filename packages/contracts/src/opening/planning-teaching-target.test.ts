import { expect, it } from "vitest";
import { taskItemSchema, taskCreateResultSchema } from "./planning-tasks";
const id = "11111111-1111-4111-8111-111111111111";
const task = { id, title: "学习任务", minutes: 20, dueAt: null, priority: 1, status: "pending" };
const teachingTarget = { activityId: id, courseId: id, requirementKey: null };
it("preserves legacy absence without filling target state", () => {
  for (const schema of [taskItemSchema, taskCreateResultSchema]) {
    expect(schema.parse(task)).toEqual(task);
    expect(schema.parse({ ...task, teachingTarget })).toEqual({ ...task, teachingTarget });
  }
});
it.each(["conflicting_binding", "unavailable_binding"])("accepts explicit %s without an invented target", teachingTargetUnavailable => {
  for (const schema of [taskItemSchema, taskCreateResultSchema]) {
    const input = { ...task, teachingTargetUnavailable };
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ ...input, teachingTarget }).success).toBe(false);
  }
});
it("rejects null, unknown states and fabricated target identities", () => {
  for (const teachingTargetUnavailable of [null, "unknown", "", 1]) {
    expect(taskItemSchema.safeParse({ ...task, teachingTargetUnavailable }).success).toBe(false);
  }
  expect(taskItemSchema.safeParse({ ...task, teachingTarget: { ...teachingTarget, activityId: "unavailable" } }).success).toBe(false);
});
