import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Reminder } from "@aistudy/contracts";
import {
  externalChannelConfigured,
  isQueueableDueTask,
  reminderDeliveryState,
  reminderIdempotencyKey,
  type ExternalReminderConfig,
  type ReminderChannel,
} from "@aistudy/domain";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";

type ReminderPayload = {
  taskId: string;
  taskVersion: number;
  dueAt: string;
  channel: ReminderChannel;
  title: string;
  receiptId: string | null;
  outcome: "acknowledged" | "rejected" | "unknown" | "quiet" | "rate_limited" | null;
  clientKey: string | null;
  configured: boolean;
};

const EXTERNAL_KEY = "remind-external-config";

function mapReminder(row: Record<string, unknown>, configured: boolean): Reminder {
  const payload = row.payload as ReminderPayload;
  const state = row.state as string;
  const outcome = state === "outcome_unknown" ? "unknown" : payload.outcome;
  return {
    id: row.id as string,
    taskId: payload.taskId,
    dueAt: payload.dueAt,
    channel: payload.channel,
    status: reminderDeliveryState({
      channel: payload.channel,
      configured: payload.channel === "in_app" ? true : configured && payload.configured,
      receiptId: payload.receiptId,
      outcome,
    }),
    receiptId: payload.receiptId,
    taskVersion: payload.taskVersion,
    outcome,
  };
}

export function createOpeningReminderRepository(sql: Sql) {
  return {
    async list(scope: OpeningScope, now = new Date()): Promise<{
      reminders: Reminder[];
      externalDelivery: "disabled" | "configured";
    }> {
      const config = await readConfig(sql, scope);
      const configured = externalChannelConfigured(config);
      const tasks = await sql`
        SELECT id, title, due_at, status, version FROM opening_tasks
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
      const jobs = await sql`
        SELECT id, key, payload, state FROM opening_jobs
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND kind = ${"remind"}`;
      const byKey = new Map(jobs.map((row) => [String((row as Record<string, unknown>).key), row]));
      const reminders: Reminder[] = [];
      for (const raw of tasks) {
        const task = raw as Record<string, unknown>;
        const dueAt = task.due_at ? new Date(task.due_at as string | Date).toISOString() : null;
        const ref = {
          id: task.id as string,
          version: Number(task.version),
          dueAt,
          status: task.status as "pending" | "done" | "skipped",
        };
        if (!isQueueableDueTask(ref, now) || !dueAt) continue;
        const key = reminderIdempotencyKey({
          taskId: ref.id,
          version: ref.version,
          dueAt,
          channel: "in_app",
        });
        const existing = byKey.get(key) as Record<string, unknown> | undefined;
        reminders.push(existing
          ? mapReminder(existing, configured)
          : {
            id: ref.id,
            taskId: ref.id,
            dueAt,
            channel: "in_app",
            status: "due",
            receiptId: null,
            taskVersion: ref.version,
            outcome: null,
          });
      }
      for (const raw of jobs) {
        const row = raw as Record<string, unknown>;
        const payload = row.payload as ReminderPayload;
        if (payload.channel === "in_app") continue;
        reminders.push(mapReminder(row, configured));
      }
      return { reminders, externalDelivery: configured ? "configured" : "disabled" };
    },

    async enqueue(
      scope: OpeningScope,
      input: { clientKey: string; channel: ReminderChannel },
      now = new Date(),
    ): Promise<Reminder[]> {
      if (input.clientKey.length < 8) throw new OpeningPlanError("VALIDATION", "clientKey required");
      const config = await readConfig(sql, scope);
      const configured = externalChannelConfigured(config);
      if (input.channel !== "in_app" && !configured) {
        throw new OpeningPlanError("VALIDATION", "external reminder channel is disabled");
      }
      const tasks = await sql`
        SELECT id, title, due_at, status, version FROM opening_tasks
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
      const queued: Array<Reminder & { created: boolean }> = [];
      for (const raw of tasks) {
        const task = raw as Record<string, unknown>;
        const dueAt = task.due_at ? new Date(task.due_at as string | Date).toISOString() : null;
        const ref = {
          id: task.id as string,
          version: Number(task.version),
          dueAt,
          status: task.status as "pending" | "done" | "skipped",
        };
        if (!isQueueableDueTask(ref, now) || !dueAt) continue;
        const payload: ReminderPayload = {
          taskId: ref.id,
          taskVersion: ref.version,
          dueAt,
          channel: input.channel,
          title: String(task.title),
          receiptId: null,
          outcome: null,
          clientKey: input.clientKey,
          configured,
        };
        const key = reminderIdempotencyKey({
          taskId: ref.id, version: ref.version, dueAt, channel: input.channel,
        });
        const rows = await insertRemindJob(sql, scope, key, payload);
        queued.push({ ...mapReminder(rows.row, configured), created: rows.created });
      }
      return queued;
    },

    async saveExternalConfig(scope: OpeningScope, config: ExternalReminderConfig): Promise<void> {
      await sql`
        INSERT INTO opening_jobs (
          id, workspace_id, owner_user_id, key, kind, payload, state, privacy_epoch
        ) VALUES (
          ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${EXTERNAL_KEY},
          ${"remind"}, ${sql.json({ config: true, ...config } as never)}, ${"succeeded"}, ${0}
        )
        ON CONFLICT (workspace_id, key) DO UPDATE
          SET payload = EXCLUDED.payload, updated_at = now()`;
    },

    async claimDue(limit = 20): Promise<Array<Record<string, unknown>>> {
      const rows = await sql`
        UPDATE opening_jobs SET state = 'running', updated_at = now()
        WHERE id IN (
          SELECT id FROM opening_jobs
          WHERE kind = ${"remind"} AND state = 'queued'
            AND COALESCE(payload->>'config', 'false') <> 'true'
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        RETURNING *`;
      return rows as Array<Record<string, unknown>>;
    },

    async recordAttempt(
      id: string,
      input: { receiptId: string | null; outcome: ReminderPayload["outcome"]; state: "succeeded" | "failed" | "outcome_unknown" | "queued" },
    ): Promise<boolean> {
      const rows = await sql`
        UPDATE opening_jobs
        SET state = ${input.state},
            payload = payload || ${sql.json({ receiptId: input.receiptId, outcome: input.outcome } as never)},
            result = ${sql.json({ receiptId: input.receiptId, outcome: input.outcome } as never)},
            updated_at = now()
        WHERE id = ${id} AND state = 'running' AND kind = ${"remind"}
        RETURNING id`;
      return rows.length > 0;
    },
  };
}

async function readConfig(sql: Sql, scope: OpeningScope): Promise<ExternalReminderConfig | null> {
  const rows = await sql`
    SELECT payload FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      AND key = ${EXTERNAL_KEY} AND kind = ${"remind"} LIMIT 1`;
  if (!rows.length) return null;
  const payload = (rows[0] as Record<string, unknown>).payload as ExternalReminderConfig;
  return {
    enabled: Boolean(payload.enabled),
    recipientId: payload.recipientId ?? null,
    quietHours: payload.quietHours ?? null,
  };
}

async function insertRemindJob(sql: Sql, scope: OpeningScope, key: string, payload: ReminderPayload) {
  const inserted = await sql`
    INSERT INTO opening_jobs (
      id, workspace_id, owner_user_id, key, kind, payload, state, privacy_epoch
    ) VALUES (
      ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${key}, ${"remind"},
      ${sql.json(payload as never)}, ${"queued"}, ${0}
    )
    ON CONFLICT (workspace_id, key) DO NOTHING
    RETURNING *`;
  if (inserted.length) return { row: inserted[0] as Record<string, unknown>, created: true };
  const existing = await sql`
    SELECT * FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId} AND key = ${key} AND kind = ${"remind"}`;
  const row = existing[0] as Record<string, unknown> | undefined;
  if (!row) throw new OpeningPlanError("NOT_FOUND", "reminder disappeared after conflict");
  return { row, created: false };
}

export type OpeningReminderRepository = ReturnType<typeof createOpeningReminderRepository>;
