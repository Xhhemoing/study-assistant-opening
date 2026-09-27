import { describe, expect, it } from "vitest";
import {
  externalChannelConfigured,
  isQueueableDueTask,
  isWithinQuietHours,
  reminderDeliveryState,
  reminderIdempotencyKey,
} from "./reminder-policy";

describe("reminder delivery state", () => {
  it("does not claim an unconfigured push was delivered", () => {
    expect(reminderDeliveryState({ channel: "feishu", configured: false, receiptId: null })).toBe("disabled");
    expect(reminderDeliveryState({ channel: "in_app", configured: true, receiptId: null })).toBe("due");
  });

  it("marks sent only after a provider receipt", () => {
    expect(reminderDeliveryState({
      channel: "feishu",
      configured: true,
      receiptId: "rcp-1",
      outcome: "acknowledged",
    })).toBe("sent");
    expect(reminderDeliveryState({
      channel: "feishu",
      configured: true,
      receiptId: null,
      outcome: "unknown",
    })).toBe("sending");
  });

  it("keeps rejected and rate-limited outcomes visible as failed", () => {
    expect(reminderDeliveryState({
      channel: "feishu",
      configured: true,
      receiptId: null,
      outcome: "rejected",
    })).toBe("failed");
    expect(reminderDeliveryState({
      channel: "feishu",
      configured: true,
      receiptId: null,
      outcome: "rate_limited",
    })).toBe("failed");
  });

  it("leaves quiet hours due instead of sending", () => {
    expect(reminderDeliveryState({
      channel: "feishu",
      configured: true,
      receiptId: null,
      outcome: "quiet",
    })).toBe("due");
  });
});

describe("reminder queue rules", () => {
  const now = new Date("2026-09-14T12:00:00.000Z");

  it("defaults external delivery to disabled", () => {
    expect(externalChannelConfigured(null)).toBe(false);
    expect(externalChannelConfigured({ enabled: true, recipientId: null, quietHours: null })).toBe(false);
    expect(externalChannelConfigured({
      enabled: true,
      recipientId: "owner-1",
      quietHours: null,
    })).toBe(true);
  });

  it("queues only pending tasks whose confirmed due instant has passed", () => {
    expect(isQueueableDueTask({
      id: "t",
      version: 1,
      dueAt: "2026-09-14T11:00:00.000Z",
      status: "pending",
    }, now)).toBe(true);
    expect(isQueueableDueTask({
      id: "t",
      version: 1,
      dueAt: null,
      status: "pending",
    }, now)).toBe(false);
    expect(isQueueableDueTask({
      id: "t",
      version: 1,
      dueAt: "2026-09-14T11:00:00.000Z",
      status: "done",
    }, now)).toBe(false);
  });

  it("dedupes by task, version, due instant and channel", () => {
    const key = reminderIdempotencyKey({
      taskId: "task-1",
      version: 2,
      dueAt: "2026-09-14T11:00:00.000Z",
      channel: "in_app",
    });
    expect(key).toBe("remind:task-1:v2:2026-09-14T11:00:00.000Z:in_app");
    expect(reminderIdempotencyKey({
      taskId: "task-1",
      version: 3,
      dueAt: "2026-09-14T11:00:00.000Z",
      channel: "in_app",
    })).not.toBe(key);
  });

  it("respects overnight quiet hours in the owner timezone", () => {
    const quiet = { startMinute: 22 * 60, endMinute: 7 * 60 };
    expect(isWithinQuietHours(new Date("2026-09-14T15:30:00.000Z"), quiet, "Asia/Shanghai")).toBe(true);
    expect(isWithinQuietHours(new Date("2026-09-14T03:30:00.000Z"), quiet, "Asia/Shanghai")).toBe(false);
  });
});
