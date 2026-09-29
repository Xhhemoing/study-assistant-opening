import { describe, expect, it } from "vitest";
import { reminderEnqueueInputSchema, reminderListSchema, reminderSchema, taskStatusUpdateInputSchema } from "./planning";

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
