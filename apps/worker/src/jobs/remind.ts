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
};

export type RemindHandlerDeps = {
  record(id: string, input: RemindRecord): Promise<boolean>;
  send(input: ReminderSendInput, signal: AbortSignal): Promise<ReminderSendResult>;
  now?: () => Date;
  quietHours?: () => QuietHours | null;
  timeZone?: () => string;
  recipientId?: () => string | null;
  externalConfig?: () => ExternalReminderConfig | null;
};

export function createRemindHandler(deps: RemindHandlerDeps) {
  return async function processRemind(job: OpeningJobRecord, payload: unknown) {
    const body = payload as RemindPayload;
    if (body.outcome === "unknown") {
      return {
        status: reminderDeliveryState({
          channel: body.channel,
          configured: body.configured,
          receiptId: body.receiptId,
          outcome: "unknown",
        }),
        receiptId: body.receiptId,
        outcome: "unknown" as const,
        channel: body.channel,
      };
    }
    const configured = body.channel === "in_app"
      ? true
      : body.configured && externalChannelConfigured(deps.externalConfig?.() ?? {
        enabled: body.configured,
        recipientId: body.configured ? job.ownerUserId : null,
        quietHours: deps.quietHours?.() ?? null,
      });
    if (body.channel === "in_app" || !configured) {
      await deps.record(job.id, { receiptId: null, outcome: null, state: "succeeded" });
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
    const quiet = deps.quietHours?.() ?? null;
    if (isWithinQuietHours(deps.now?.() ?? new Date(), quiet, deps.timeZone?.() ?? "Asia/Shanghai")) {
      await deps.record(job.id, { receiptId: null, outcome: "quiet", state: "queued" });
      return { status: "due" as const, receiptId: null, outcome: "quiet" as const, channel: body.channel };
    }
    const recipientId = deps.recipientId?.() ?? job.ownerUserId;
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
