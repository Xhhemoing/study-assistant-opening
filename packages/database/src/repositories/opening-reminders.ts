import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { Reminder } from "@aistudy/contracts";
import {
  externalChannelConfigured,
  isRetestActivityDue,
  isQueueableDueTask,
  reminderDeliveryState,
  reminderIdempotencyKey,
  type ExternalReminderConfig,
  type ReminderChannel,
} from "@aistudy/domain";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import { lockLearningOwner } from "./opening-learning-facts";
import { mapOpeningRetestActivity } from "./opening-retest-activities";
import { lockLearningPreferences, readLearningAutomationState } from "./opening-learning-preferences";
import type { RetestActivity } from "@aistudy/contracts";

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
  suppressed?: boolean;
};

const EXTERNAL_KEY = "remind-external-config";

async function automaticReminderAllowed(
  sql: Sql | TransactionSql, scope: OpeningScope, activity: RetestActivity, jobId?: string,
): Promise<boolean> {
  if (!activity.courseId) return false;
  const state = await readLearningAutomationState(sql, scope, activity.courseId);
  if (!state.preferences.automaticRemindersEnabled || !state.automaticRemindersEnabledAt) return false;
  // Compare persisted timestamps in Postgres so rapid toggles retain microsecond ordering.
  const [row] = await sql`SELECT a.accepted_at >= GREATEST(p.automatic_reminders_enabled_at,c.automatic_reminders_enabled_at)
      AND (${jobId ?? null}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM opening_jobs j WHERE j.id=${jobId ?? null}
          AND j.workspace_id=a.workspace_id AND j.owner_user_id=a.owner_user_id
          AND j.created_at >= GREATEST(p.automatic_reminders_enabled_at,c.automatic_reminders_enabled_at)
      )) AS current
    FROM opening_retest_activities a JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id
    JOIN workspace_preferences p ON p.workspace_id=a.workspace_id
    WHERE a.id=${activity.activityId} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
  return row?.current === true;
}

function currentDueAt(task: Record<string, unknown> | undefined, activity: RetestActivity | undefined, now: Date): string | null {
  if (!task || task.status !== "pending") return null;
  if (activity) {
    return isRetestActivityDue(activity, now)
      ? activity.times.scheduledStartAt ?? activity.times.recommendedAt : null;
  }
  const dueAt = task.due_at ? new Date(task.due_at as string | Date).toISOString() : null;
  return isQueueableDueTask({ id: String(task.id), version: Number(task.version), dueAt, status: "pending" }, now) ? dueAt : null;
}
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
      configured: payload.channel === "in_app" || Boolean(payload.receiptId) || outcome === "unknown" || configured && payload.configured,
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
      const activities = await sql`SELECT * FROM opening_retest_activities
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      const activityByTask = new Map(activities.map((row) => {
        const activity = mapOpeningRetestActivity(row as Record<string, unknown>);
        return [activity.taskId, activity] as const;
      }));
      const jobs = await sql`
        SELECT id, key, payload, state FROM opening_jobs
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND kind = ${"remind"} AND COALESCE(payload->>'config', 'false') <> 'true'`;
      const byKey = new Map(jobs.map((row) => [String((row as Record<string, unknown>).key), row]));
      const taskById = new Map(tasks.map((row) => [String(row.id), row as Record<string, unknown>]));
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
        if (ref.status !== "pending") continue;
        const activity = activityByTask.get(ref.id);
        if (activity && !(await automaticReminderAllowed(sql, scope, activity))) continue;
        if (activity ? !isRetestActivityDue(activity, now) : !isQueueableDueTask(ref, now) || !dueAt) continue;
        if (!dueAt && !activity) continue;
        const effectiveDueAt = activity?.times.scheduledStartAt ?? activity?.times.recommendedAt ?? dueAt;
        if (!effectiveDueAt) continue;
        const key = reminderIdempotencyKey({
          taskId: ref.id,
          version: ref.version,
          dueAt: effectiveDueAt,
          channel: "in_app",
        });
        const existing = byKey.get(key) as Record<string, unknown> | undefined;
        reminders.push(existing
          ? mapReminder(existing, configured)
          : {
            id: ref.id,
            taskId: ref.id,
            dueAt: effectiveDueAt,
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
        const sentOrUnknown = Boolean(payload.receiptId) || payload.outcome === "unknown" || row.state === "outcome_unknown";
        if (!sentOrUnknown) {
          if (payload.suppressed) continue;
          const task = taskById.get(payload.taskId);
          const activity = activityByTask.get(payload.taskId);
          if (!task || Number(task.version) !== payload.taskVersion || currentDueAt(task, activity, now) !== payload.dueAt) continue;
          if (activity && !(await automaticReminderAllowed(sql, scope, activity, String(row.id)))) continue;
        }
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
      const activities = await sql`SELECT * FROM opening_retest_activities
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      const activityByTask = new Map(activities.map((row) => {
        const activity = mapOpeningRetestActivity(row as Record<string, unknown>);
        return [activity.taskId, activity] as const;
      }));
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
        if (ref.status !== "pending") continue;
        const activity = activityByTask.get(ref.id);
        if (activity ? !isRetestActivityDue(activity, now) : !isQueueableDueTask(ref, now) || !dueAt) continue;
        if (!dueAt && !activity) continue;
        const effectiveDueAt = activity?.times.scheduledStartAt ?? activity?.times.recommendedAt ?? dueAt;
        if (!effectiveDueAt) continue;
        const payload: ReminderPayload = {
          taskId: ref.id,
          taskVersion: ref.version,
          dueAt: effectiveDueAt,
          channel: input.channel,
          title: String(task.title),
          receiptId: null,
          outcome: null,
          clientKey: input.clientKey,
          configured,
        };
        const key = reminderIdempotencyKey({
          taskId: ref.id, version: ref.version, dueAt: effectiveDueAt, channel: input.channel,
        });
        const rows = await sql.begin(async (tx) => {
          await lockLearningOwner(tx, scope);
          if (activity) {
            if (!activity.courseId) return null;
            await lockLearningPreferences(tx, scope, activity.courseId);
          }
          // Match task completion/submission: preference locks, then activity, then task.
          const currentActivities = await tx`SELECT * FROM opening_retest_activities
            WHERE task_id=${ref.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
          const currentActivity = currentActivities[0] ? mapOpeningRetestActivity(currentActivities[0] as Record<string, unknown>) : undefined;
          if (currentActivity?.activityId !== activity?.activityId || currentActivity?.courseId !== activity?.courseId) return null;
          const [currentTask] = await tx`SELECT id,title,due_at,status,version FROM opening_tasks
            WHERE id=${ref.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
          if (!currentTask || Number(currentTask.version) !== ref.version || currentDueAt(currentTask, currentActivity, now) !== effectiveDueAt) return null;
          if (currentActivity && !(await automaticReminderAllowed(tx, scope, currentActivity))) return null;
          return insertRemindJob(tx, scope, key, { ...payload, title: String(currentTask.title) });
        });
        if (!rows) continue;
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

    async isCurrent(id: string, now = new Date()): Promise<boolean> {
      return sql.begin(async (tx) => {
        const rows = await tx`SELECT j.payload, j.workspace_id AS job_workspace_id,
            j.owner_user_id AS job_owner_user_id,
            a.*, a.id AS activity_id, t.id AS task_id,
            t.status AS task_status, t.version AS task_version, t.due_at
          FROM opening_jobs j
          LEFT JOIN opening_tasks t ON t.id::text = j.payload->>'taskId'
            AND t.workspace_id=j.workspace_id AND t.owner_user_id=j.owner_user_id
          LEFT JOIN opening_retest_activities a ON a.task_id=t.id
            AND a.workspace_id=j.workspace_id AND a.owner_user_id=j.owner_user_id
          WHERE j.id=${id} AND j.kind='remind' AND j.state='running'`;
        if (!rows.length) return false;
        const row = rows[0] as Record<string, unknown>;
        const payload = row.payload as ReminderPayload;
        if (row.task_id == null || Number(row.task_version) !== payload.taskVersion || row.task_status !== "pending") return false;
        const activity = row.activity_id == null ? null : mapOpeningRetestActivity(row);
        if (activity) {
          if (!activity.courseId) return false;
          const scope = { workspaceId: String(row.job_workspace_id), ownerUserId: String(row.job_owner_user_id) };
          await lockLearningPreferences(tx, scope, activity.courseId);
          if (!(await automaticReminderAllowed(tx, scope, activity, id))) return false;
          const effectiveDueAt = activity.times.scheduledStartAt ?? activity.times.recommendedAt;
          return effectiveDueAt === payload.dueAt && isRetestActivityDue(activity, now);
        }
        const dueAt = row.due_at == null ? null : new Date(row.due_at as string | Date).toISOString();
        return dueAt === payload.dueAt && isQueueableDueTask({
          id: String(row.task_id), version: Number(row.task_version), dueAt, status: "pending",
        }, now);
      }) as Promise<boolean>;
    },

    async recordAttempt(
      id: string,
      input: { receiptId: string | null; outcome: ReminderPayload["outcome"]; state: "succeeded" | "failed" | "outcome_unknown" | "queued"; suppressed?: boolean },
    ): Promise<boolean> {
      const rows = await sql`
        UPDATE opening_jobs
        SET state = ${input.state},
            payload = payload || ${sql.json({ receiptId: input.receiptId, outcome: input.outcome, suppressed: input.suppressed ?? false } as never)},
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

async function insertRemindJob(sql: Sql | TransactionSql, scope: OpeningScope, key: string, payload: ReminderPayload) {
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
