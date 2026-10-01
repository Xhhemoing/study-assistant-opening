import { describe, expect, it } from "vitest";
import { reminderEnqueueInputSchema, reminderListSchema, reminderSchema, taskItemSchema, taskStatusUpdateInputSchema } from "./planning";

const reminder = {
  id: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  dueAt: "2026-09-14T11:00:00.000Z",
  channel: "in_app" as const,
  status: "due" as const,
  receiptId: null,
  taskVersion: 1,
  outcome: null,
};

describe("reminder contract", () => {
  it("accepts the real task version while preserving old task responses", () => {
    const task = { id: reminder.taskId, title: "Due task", minutes: 25, dueAt: reminder.dueAt, priority: 1, status: "pending" };
    expect(taskItemSchema.parse({ ...task, version: 4 }).version).toBe(4);
    expect(taskItemSchema.safeParse(task).success).toBe(true);
    expect(taskItemSchema.safeParse({ ...task, version: 0 }).success).toBe(false);
  });
  it("accepts an explicit single-task request with its current version", () => {
    expect(reminderEnqueueInputSchema.parse({ clientKey: "single-due-01", taskId: reminder.taskId, expectedVersion: 3 }))
      .toEqual({ clientKey: "single-due-01", channel: "in_app", taskId: reminder.taskId, expectedVersion: 3 });
  });

  it.each([{ taskId: reminder.taskId }, { expectedVersion: 1 },
    { taskId: reminder.taskId, expectedVersion: 0 }, { taskId: reminder.taskId, expectedVersion: 1.5 },
    { taskId: "bad", expectedVersion: 1 }, { taskId: reminder.taskId, expectedVersion: 1, dueAt: reminder.dueAt },
  ])("rejects incomplete or caller-controlled single-due selection %j", input => {
    expect(reminderEnqueueInputSchema.safeParse({ clientKey: "single-due-01", ...input }).success).toBe(false);
  });
  it("requires a receipt field and does not treat due as sent", () => {
    expect(reminderSchema.parse(reminder).status).toBe("due");
    expect(reminderSchema.parse({ ...reminder, channel: "feishu", status: "disabled" }).status).toBe("disabled");
    expect(reminderSchema.safeParse({ ...reminder, status: "sent", receiptId: null }).success).toBe(true);
    expect(reminderSchema.safeParse({ ...reminder, receiptId: "" }).success).toBe(false);
  });

  it("defaults enqueue to in-app and requires a client key", () => {
    expect(reminderEnqueueInputSchema.parse({ clientKey: "remind-key-01" }).channel).toBe("in_app");
    expect(reminderEnqueueInputSchema.safeParse({ clientKey: "short" }).success).toBe(false);
  });

  it("publishes external delivery as disabled unless configured", () => {
    const list = reminderListSchema.parse({ reminders: [reminder], externalDelivery: "disabled" });
    expect(list.externalDelivery).toBe("disabled");
    expect(list.reminders[0]?.receiptId).toBeNull();
  });

  it("requires a version and timestamp when completing or skipping a task", () => {
    expect(taskStatusUpdateInputSchema.parse({
      status: "done", expectedVersion: 1, at: "2026-09-29T12:00:00.000Z",
    }).status).toBe("done");
    expect(taskStatusUpdateInputSchema.safeParse({ status: "done", expectedVersion: 0 }).success).toBe(false);
  });
});
