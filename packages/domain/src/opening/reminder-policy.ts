import type { Reminder } from "@aistudy/contracts";

export type ReminderChannel = Reminder["channel"];
export type ReminderStatus = Reminder["status"];

/** Visible delivery facts. In-app due is not a push. */
export type ReminderDeliveryInput = {
  channel: ReminderChannel;
  configured: boolean;
  receiptId: string | null;
  outcome?: "acknowledged" | "rejected" | "unknown" | "quiet" | "rate_limited" | null;
};

export type QuietHours = {
  /** Inclusive local start minute, 0..1439. */
  startMinute: number;
  /** Exclusive local end minute. Overnight when end <= start. */
  endMinute: number;
};

/** Owner-configured external channel. Default is disabled. */
export type ExternalReminderConfig = {
  enabled: boolean;
  recipientId: string | null;
  quietHours: QuietHours | null;
};

export type DueTaskRef = {
  id: string;
  version: number;
  dueAt: string | null;
  status: "pending" | "done" | "skipped";
};

/**
 * Honest delivery status. `sent` requires a provider receipt.
 * Opening an in-app list stays `due` and is never called push.
 */
export function reminderDeliveryState(input: ReminderDeliveryInput): ReminderStatus {
  if (input.channel !== "in_app" && !input.configured) return "disabled";
  if (input.outcome === "unknown") return "sending";
  if (input.outcome === "quiet") return "due";
  if (input.receiptId) return "sent";
  if (input.outcome === "rejected" || input.outcome === "rate_limited") return "failed";
  return "due";
}

/** External send is off unless the owner explicitly enabled a recipient. */
export function externalChannelConfigured(config: ExternalReminderConfig | null | undefined): boolean {
  if (!config?.enabled) return false;
  return typeof config.recipientId === "string" && config.recipientId.length > 0;
}

export function isWithinQuietHours(now: Date, quiet: QuietHours | null, timeZone: string): boolean {
  if (!quiet) return false;
  const minute = localMinute(now, timeZone);
  if (quiet.startMinute === quiet.endMinute) return true;
  if (quiet.startMinute < quiet.endMinute) {
    return minute >= quiet.startMinute && minute < quiet.endMinute;
  }
  return minute >= quiet.startMinute || minute < quiet.endMinute;
}

/** Stable idempotency key: task + version + due instant + channel. */
export function reminderIdempotencyKey(input: {
  taskId: string;
  version: number;
  dueAt: string;
  channel: ReminderChannel;
}): string {
  return `remind:${input.taskId}:v${input.version}:${input.dueAt}:${input.channel}`;
}

/** Only a still-pending task with a confirmed due instant can be queued. */
export function isQueueableDueTask(task: DueTaskRef, now: Date): boolean {
  if (task.status !== "pending" || !task.dueAt) return false;
  const due = Date.parse(task.dueAt);
  return Number.isFinite(due) && due <= now.getTime();
}

function localMinute(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}
