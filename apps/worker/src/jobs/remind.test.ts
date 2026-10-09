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

const liveConfig = () => ({ enabled: true, recipientId: job.ownerUserId, quietHours: null });

describe("remind job", () => {
  it("does not send when only the stale payload says external delivery is configured", async () => {
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "unexpected" }));
    const handler = createRemindHandler({ record: async () => true, send, now: () => now });
    expect(await handler(job, payload())).toMatchObject({ status: "disabled", receiptId: null });
    expect(send).not.toHaveBeenCalled();
  });

  it("loads live configuration for this job and honors a newly disabled channel", async () => {
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "unexpected" }));
    const externalConfig = vi.fn(async () => ({ ...liveConfig(), enabled: false }));
    const handler = createRemindHandler({ record: async () => true, send, externalConfig, now: () => now });
    expect(await handler(job, payload())).toMatchObject({ status: "disabled", receiptId: null });
    expect(externalConfig).toHaveBeenCalledWith(job);
    expect(send).not.toHaveBeenCalled();
  });

  it("uses current configuration quiet hours before sending", async () => {
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "unexpected" }));
    const record = vi.fn(async () => true);
    const handler = createRemindHandler({ record, send, now: () => new Date("2026-09-14T15:30:00.000Z"),
      externalConfig: async () => ({ ...liveConfig(), quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } }) });
    expect(await handler(job, payload())).toMatchObject({ status: "due", outcome: "quiet" });
    expect(record).toHaveBeenCalledWith(job.id, {
      receiptId: null, outcome: "quiet", state: "queued", availableAt: "2026-09-14T23:00:00.000Z",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks all-day quiet configuration after one day instead of creating an immediate loop", async () => {
    const record = vi.fn(async () => true);
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "unexpected" }));
    const handler = createRemindHandler({ record, send, now: () => now,
      externalConfig: async () => ({ ...liveConfig(), quietHours: { startMinute: 0, endMinute: 0 } }) });
    await handler(job, payload());
    expect(record).toHaveBeenCalledWith(job.id, {
      receiptId: null, outcome: "quiet", state: "queued", availableAt: "2026-09-15T12:00:00.000Z",
    });
    expect(send).not.toHaveBeenCalled();
  });
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
      externalConfig: liveConfig,
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
      externalConfig: () => ({ ...liveConfig(), quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } }),
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
      externalConfig: liveConfig,
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
      externalConfig: () => ({ ...liveConfig(), recipientId: "someone-else" }),
    });

    await expect(handler(job, payload())).rejects.toThrow(/owner/);
    expect(send).not.toHaveBeenCalled();
  });

  it("re-reads the task state before an external send and suppresses a stale job", async () => {
    const record = vi.fn(async () => true);
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "unexpected" }));
    const handler = createRemindHandler({
      record,
      send,
      isCurrent: async () => false,
      now: () => now,
    });

    const result = await handler(job, payload());

    expect(send).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith("job-1", {
      receiptId: null, outcome: null, state: "succeeded", suppressed: true,
    });
    expect(result).toMatchObject({ status: "due", suppressed: true });
  });

  it("TZ01: payload.timeZone wins over resolveTimeZone for quiet-hours wall clock", async () => {
    const record = vi.fn(async () => true);
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "unexpected" }));
    // 2026-09-14T15:30Z = 23:30 Asia/Shanghai (in 22:00–07:00 quiet)
    // same instant = 11:30 America/New_York (NOT in quiet)
    const handler = createRemindHandler({
      record,
      send,
      now: () => new Date("2026-09-14T15:30:00.000Z"),
      externalConfig: async () => ({ ...liveConfig(), quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } }),
      resolveTimeZone: async () => "America/New_York",
    });
    expect(await handler(job, payload({ timeZone: "Asia/Shanghai" }))).toMatchObject({
      status: "due",
      outcome: "quiet",
    });
    expect(send).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(job.id, expect.objectContaining({ outcome: "quiet" }));
  });

  it("TZ01: resolveTimeZone supplies workspace TZ when payload omits timeZone", async () => {
    const record = vi.fn(async () => true);
    const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "unexpected" }));
    const resolveTimeZone = vi.fn(async () => "Asia/Shanghai");
    const handler = createRemindHandler({
      record,
      send,
      now: () => new Date("2026-09-14T15:30:00.000Z"),
      externalConfig: async () => ({ ...liveConfig(), quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } }),
      resolveTimeZone,
    });
    expect(await handler(job, payload())).toMatchObject({ status: "due", outcome: "quiet" });
    expect(resolveTimeZone).toHaveBeenCalledWith(job);
    expect(send).not.toHaveBeenCalled();
  });

});

it("preserves an acknowledged provider receipt when a replay is no longer current", async () => {
  const record = vi.fn(async () => true);
  const send = vi.fn(async (): Promise<ReminderSendResult> => ({ receiptId: "duplicate" }));
  const handler = createRemindHandler({ record, send, isCurrent: async () => false, now: () => now });

  const result = await handler(job, payload({ outcome: "acknowledged", receiptId: "original-receipt" }));

  expect(result).toMatchObject({ status: "sent", outcome: "acknowledged", receiptId: "original-receipt" });
  expect(send).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});
