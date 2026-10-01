import type { OpeningJobRecord } from "@aistudy/database";
import {
  externalChannelConfigured,
  isWithinQuietHours,
  reminderDeliveryState,
  type ExternalReminderConfig,
  type QuietHours,
  type ReminderChannel,
} from "@aistudy/domain";

export type ReminderSendInput = {
  recipientId: string;
  text: string;
  idempotencyKey: string;
};

export type ReminderSendResult = { receiptId: string } | { error: "not_configured" | "rejected" | "rate_limited" | "unknown" };

export type RemindPayload = {
  taskId: string;
  taskVersion: number;
  dueAt: string;
  channel: ReminderChannel;
  title: string;
  receiptId: string | null;
  outcome: "acknowledged" | "rejected" | "unknown" | "quiet" | "rate_limited" | null;
  configured: boolean;
};

export type RemindRecord = {
  receiptId: string | null;
  outcome: RemindPayload["outcome"];
  state: "succeeded" | "failed" | "outcome_unknown" | "queued";
  suppressed?: boolean;
  availableAt?: string;
};

export type RemindHandlerDeps = {
  record(id: string, input: RemindRecord): Promise<boolean>;
  send(input: ReminderSendInput, signal: AbortSignal): Promise<ReminderSendResult>;
  now?: () => Date;
  quietHours?: () => QuietHours | null;
  timeZone?: () => string;
  recipientId?: () => string | null;
  externalConfig?: (job: OpeningJobRecord) => ExternalReminderConfig | null | Promise<ExternalReminderConfig | null>;
  isCurrent?: (jobId: string, now: Date) => Promise<boolean>;
};

export function createRemindHandler(deps: RemindHandlerDeps) {
  return async function processRemind(job: OpeningJobRecord, payload: unknown) {
    const body = payload as RemindPayload;
    if (body.outcome === "unknown" || body.receiptId) {
      return {
        status: reminderDeliveryState({
          channel: body.channel,
          configured: true,
          receiptId: body.receiptId,
          outcome: body.outcome,
        }),
        receiptId: body.receiptId,
        outcome: body.outcome,
        channel: body.channel,
      };
    }
    const current = await deps.isCurrent?.(job.id, deps.now?.() ?? new Date());
    if (current === false) {
      await deps.record(job.id, { receiptId: null, outcome: null, state: "succeeded", suppressed: true });
      return { status: "due" as const, receiptId: null, outcome: null, channel: body.channel, suppressed: true };
    }
    const liveConfig = body.channel === "in_app" ? null : await deps.externalConfig?.(job) ?? null;
    const configured = body.channel === "in_app" || body.configured && externalChannelConfigured(liveConfig);
    if (body.channel === "in_app" || !configured) {
      await deps.record(job.id, { receiptId: null, outcome: null, state: "succeeded", ...(!configured ? { suppressed: true } : {}) });
      return {
        status: reminderDeliveryState({
          channel: body.channel,
          configured,
          receiptId: null,
          outcome: null,
        }),
        receiptId: null,
        outcome: null,
        channel: body.channel,
      };
    }
    const quiet = liveConfig?.quietHours ?? null;
    const now = deps.now?.() ?? new Date();
    const timeZone = deps.timeZone?.() ?? "Asia/Shanghai";
    if (isWithinQuietHours(now, quiet, timeZone)) {
      await deps.record(job.id, { receiptId: null, outcome: "quiet", state: "queued",
        availableAt: nextQuietCheck(now, quiet!, timeZone) });
      return { status: "due" as const, receiptId: null, outcome: "quiet" as const, channel: body.channel };
    }
    const recipientId = liveConfig?.recipientId;
    if (recipientId !== job.ownerUserId) {
      throw new Error("reminder recipient must be the configured owner");
    }
    const sent = await deps.send({
      recipientId,
      text: body.title,
      idempotencyKey: job.key,
    }, new AbortController().signal);
    if ("receiptId" in sent) {
      await deps.record(job.id, { receiptId: sent.receiptId, outcome: "acknowledged", state: "succeeded" });
      return { status: "sent" as const, receiptId: sent.receiptId, outcome: "acknowledged" as const, channel: body.channel };
    }
    const outcome = sent.error === "rate_limited" ? "rate_limited" as const : sent.error === "unknown" ? "unknown" as const : "rejected" as const;
    const state = outcome === "unknown" ? "outcome_unknown" as const : "failed" as const;
    await deps.record(job.id, { receiptId: null, outcome, state });
    return {
      status: reminderDeliveryState({ channel: body.channel, configured: true, receiptId: null, outcome }),
      receiptId: null,
      outcome,
      channel: body.channel,
    };
  };
}

function nextQuietCheck(now: Date, quiet: QuietHours, timeZone: string): string {
  // Equal endpoints mean all-day quiet under the existing domain policy.
  if (quiet.startMinute === quiet.endMinute) return new Date(now.getTime() + 86_400_000).toISOString();
  const nextMinute = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  // Evaluate actual instants in the configured timezone, including DST transitions.
  for (let minute = 0; minute < 26 * 60; minute++) {
    const at = new Date(nextMinute + minute * 60_000);
    if (!isWithinQuietHours(at, quiet, timeZone)) return at.toISOString();
  }
  return new Date(now.getTime() + 86_400_000).toISOString();
}
