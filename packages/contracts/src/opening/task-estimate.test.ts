import { expect, it } from "vitest";
import { taskItemSchema } from "./planning-tasks";
const task = { id: "11111111-1111-4111-8111-111111111111", title: "学习", minutes: 20, dueAt: null, priority: 1, status: "pending" };
it("accepts the read-only estimate while preserving legacy minutes and missing/null estimates", () => {
  expect(taskItemSchema.parse({ ...task, estimateMinutes: 20 })).toMatchObject({ minutes: 20, estimateMinutes: 20 });
  expect(taskItemSchema.parse({ ...task, estimateMinutes: null }).estimateMinutes).toBeNull();
  expect(taskItemSchema.parse(task).estimateMinutes).toBeUndefined();
  for (const estimateMinutes of [0, -1, 1.5, 1441, "20"]) expect(taskItemSchema.safeParse({ ...task, estimateMinutes }).success).toBe(false);
});
