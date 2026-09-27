import type { ReminderSendInput, ReminderSendResult } from "../jobs/remind";

/** Offline Feishu adapter. A receipt exists only when an injected transport returns one. */
export function createFeishuReminderAdapter(options: {
  credential: string | null;
  transport?: (input: ReminderSendInput, signal: AbortSignal) => Promise<{ receiptId: string }>;
}) {
  return {
    async send(input: ReminderSendInput, signal: AbortSignal): Promise<ReminderSendResult> {
      if (!options.credential || !options.transport) return { error: "not_configured" };
      return options.transport(input, signal);
    },
  };
}
