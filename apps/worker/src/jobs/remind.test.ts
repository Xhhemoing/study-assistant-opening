import { describe, expect, it, vi } from "vitest";
import { createRemindHandler, type ReminderSendResult } from "./remind";

const now = new Date("2026-09-14T12:00:00.000Z");
const job = {
  id: "job-1",
  workspaceId: "ws-1",
  ownerUserId: "user-1",
  key: "remind:task-1:v1:2026-09-14T11:00:00.000Z:feishu",
  kind: "remind",
  payload: {},
  result: null,
  state: "running",
  privacyEpoch: 0,
};

function payload(over: Record<string, unknown> = {}) {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    taskVersion: 1,
    dueAt: "2026-09-14T11:00:00.000Z",
    channel: "feishu",
    title: "物理作业",
    receiptId: null,
    outcome: null,
    clientKey: "remind-key-01",
    configured: true,
    ...over,
  };
}

describe("remind job", () => {
  it("records an in-app reminder as due without a push receipt", async () => {
    const record = vi.fn(async () => true);
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "should-not-send" }));
    const handler = createRemindHandler({
      record,
      send,
      now: () => now,
      quietHours: () => null,
      timeZone: () => "Asia/Shanghai",
    });

    const result = await handler(job, payload({ channel: "in_app" }));

    expect(send).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith("job-1", {
      receiptId: null,
      outcome: null,
      state: "succeeded",
    });
    expect(result).toMatchObject({ status: "due", receiptId: null, channel: "in_app" });
  });

  it("keeps an unconfigured feishu reminder disabled and does not send", async () => {
    const record = vi.fn(async () => true);
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "nope" }));
    const handler = createRemindHandler({ record, send, now: () => now });

    const result = await handler(job, payload({ configured: false }));

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "disabled", receiptId: null });
    expect(record).toHaveBeenCalledWith("job-1", expect.objectContaining({
      state: "succeeded",
      outcome: null,
      receiptId: null,
    }));
  });

  it("marks sent only when the adapter returns a receipt", async () => {
    const record = vi.fn(async () => true);
    const handler = createRemindHandler({
      record,
      send: async () => ({ receiptId: "rcp-1" }),
      now: () => now,
    });

    const result = await handler(job, payload());

    expect(result).toMatchObject({ status: "sent", receiptId: "rcp-1", outcome: "acknowledged" });
    expect(record).toHaveBeenCalledWith("job-1", {
      receiptId: "rcp-1",
      outcome: "acknowledged",
      state: "succeeded",
    });
  });

  it("keeps an unknown provider outcome visible instead of resending", async () => {
    const record = vi.fn(async () => true);
    const send = vi.fn(async () => {
      throw new Error("provider outcome unknown");
    });
    const handler = createRemindHandler({ record, send, now: () => now });

    const result = await handler(job, payload({ outcome: "unknown" }));

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "sending", outcome: "unknown" });
    expect(record).not.toHaveBeenCalled();
  });

  it("does not send during quiet hours and stays due", async () => {
    const record = vi.fn(async () => true);
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "quiet" }));
    const handler = createRemindHandler({
      record,
      send,
      now: () => new Date("2026-09-14T15:30:00.000Z"),
      quietHours: () => ({ startMinute: 22 * 60, endMinute: 7 * 60 }),
      timeZone: () => "Asia/Shanghai",
    });

    const result = await handler(job, payload());

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "due", outcome: "quiet" });
    expect(record).toHaveBeenCalledWith("job-1", expect.objectContaining({
      state: "queued",
      outcome: "quiet",
      receiptId: null,
    }));
  });

  it("records rate limits as failed without a receipt", async () => {
    const record = vi.fn(async () => true);
    const handler = createRemindHandler({
      record,
      send: async () => ({ error: "rate_limited" }),
      now: () => now,
    });

    const result = await handler(job, payload());

    expect(result).toMatchObject({ status: "failed", outcome: "rate_limited", receiptId: null });
    expect(record).toHaveBeenCalledWith("job-1", {
      receiptId: null,
      outcome: "rate_limited",
      state: "failed",
    });
  });

  it("refuses a recipient that is not the job owner", async () => {
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "x" }));
    const handler = createRemindHandler({
      record: async () => true,
      send,
      now: () => now,
      recipientId: () => "someone-else",
    });

    await expect(handler(job, payload())).rejects.toThrow(/owner/);
    expect(send).not.toHaveBeenCalled();
  });
});
