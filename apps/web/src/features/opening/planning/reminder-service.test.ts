import { describe, expect, it, vi } from "vitest";
import type { Reminder } from "@aistudy/contracts";
import { createOpeningReminderService } from "./reminder-service";

const scope = { workspaceId: "ws-1", ownerUserId: "user-1" };
const due: Reminder = {
  id: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  dueAt: "2026-09-14T11:00:00.000Z",
  channel: "in_app",
  status: "due",
  receiptId: null,
  taskVersion: 1,
  outcome: null,
};

describe("opening reminder service", () => {
  it("passes the validated single-task intent without broadening it to the due batch", async () => {
    const enqueue = vi.fn(async () => [due]);
    const service = createOpeningReminderService({ list: async () => ({ reminders: [], externalDelivery: "disabled" }), enqueue });
    const input = { clientKey: "single-due-01", taskId: due.taskId, expectedVersion: 1 };
    expect(await service.enqueue(scope, input)).toEqual([due]);
    expect(enqueue).toHaveBeenCalledWith(scope, { ...input, channel: "in_app" });
  });

  it("maps a single-task not-due rejection to 422", async () => {
    const service = createOpeningReminderService({ list: async () => ({ reminders: [], externalDelivery: "disabled" }),
      enqueue: async () => { throw Object.assign(new Error("task is not currently due"), { code: "VALIDATION" }); } });
    await expect(service.enqueue(scope, { clientKey: "single-due-01", taskId: due.taskId, expectedVersion: 1 }))
      .rejects.toMatchObject({ status: 422, code: "VALIDATION" });
  });
  it("lists in-app dues without claiming a push was delivered", async () => {
    const service = createOpeningReminderService({
      list: async () => ({ reminders: [due], externalDelivery: "disabled" }),
      enqueue: async () => [],
    });

    const listed = await service.list(scope);

    expect(listed.externalDelivery).toBe("disabled");
    expect(listed.reminders[0]).toMatchObject({ status: "due", receiptId: null, channel: "in_app" });
  });

  it("enqueues only the requested owner scope and returns queued reminders", async () => {
    const enqueue = vi.fn(async () => [{ ...due, id: "33333333-3333-4333-8333-333333333333" }]);
    const service = createOpeningReminderService({
      list: async () => ({ reminders: [], externalDelivery: "disabled" }),
      enqueue,
    });

    const queued = await service.enqueue(scope, { clientKey: "remind-key-01" });

    expect(enqueue).toHaveBeenCalledWith(scope, { clientKey: "remind-key-01", channel: "in_app" });
    expect(queued[0]?.status).toBe("due");
    expect(queued[0]?.receiptId).toBeNull();
  });

  it("maps a disabled external channel to 422", async () => {
    const service = createOpeningReminderService({
      list: async () => ({ reminders: [], externalDelivery: "disabled" }),
      enqueue: async () => {
        throw Object.assign(new Error("external reminder channel is disabled"), { code: "VALIDATION" });
      },
    });

    await expect(service.enqueue(scope, {
      clientKey: "remind-key-01",
      channel: "feishu",
    })).rejects.toMatchObject({ status: 422, code: "VALIDATION" });
  });

  it("rejects a short client key before touching the repository", async () => {
    const enqueue = vi.fn();
    const service = createOpeningReminderService({
      list: async () => ({ reminders: [], externalDelivery: "disabled" }),
      enqueue,
    });

    await expect(service.enqueue(scope, { clientKey: "short" })).rejects.toThrow(/clientKey|Too small|at least 8/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
