import { describe, expect, it } from "vitest";
import { createFeishuReminderAdapter } from "./feishu-reminder";

describe("feishu reminder adapter", () => {
  it("stays offline and does not invent a delivery receipt", async () => {
    const adapter = createFeishuReminderAdapter({ credential: null });
    const result = await adapter.send({
      recipientId: "owner-1",
      text: "物理作业 is due",
      idempotencyKey: "remind:task:v1:due:feishu",
    }, new AbortController().signal);

    expect(result.receiptId).toBeUndefined();
    expect(result.error).toBe("not_configured");
  });

  it("rejects a send when credentials exist but no transport is injected", async () => {
    const adapter = createFeishuReminderAdapter({ credential: "test-credential" });
    const result = await adapter.send({
      recipientId: "owner-1",
      text: "物理作业 is due",
      idempotencyKey: "remind:task:v1:due:feishu",
    }, new AbortController().signal);

    expect(result).toEqual({ error: "not_configured" });
  });
});
