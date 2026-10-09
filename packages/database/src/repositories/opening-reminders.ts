import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { Reminder, ReminderEnqueueInput } from "@aistudy/contracts";
import {
  DEFAULT_WORKSPACE_TIME_ZONE,
  externalChannelConfigured,
  isRetestActivityDue,
  isQueueableDueTask,
  reminderDeliveryState,
  reminderIdempotencyKey,
  resolveWorkspaceTimeZone,
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
  explicitDue?: boolean;
  /** Workspace IANA TZ at enqueue; quiet-hours share planning day boundary. */
  timeZone?: string;
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
        const explicitDue = (existing?.payload as ReminderPayload | undefined)?.explicitDue === true;
        if (activity && !explicitDue && !(await automaticReminderAllowed(sql, scope, activity))) continue;
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
          if (activity && !payload.explicitDue && !(await automaticReminderAllowed(sql, scope, activity, String(row.id)))) continue;
        }
        reminders.push(mapReminder(row, configured));
      }
      return { reminders, externalDelivery: configured ? "configured" : "disabled" };
    },

    async enqueue(
      scope: OpeningScope,
      input: ReminderEnqueueInput,
      now = new Date(),
    ): Promise<Reminder[]> {
      if (input.clientKey.length < 8) throw new OpeningPlanError("VALIDATION", "clientKey required");
      const explicit = "taskId" in input ? input : null;
      const config = await readConfig(sql, scope);
      const configured = externalChannelConfigured(config);
      if (input.channel !== "in_app" && !configured) {
        throw new OpeningPlanError("VALIDATION", "external reminder channel is disabled");
      }
      const workspaceTimeZone = await readPlanningTimeZone(sql, scope);
      const tasks = await sql`
        SELECT id, title, due_at, status, version FROM opening_tasks
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND (${explicit?.taskId ?? null}::uuid IS NULL OR id=${explicit?.taskId ?? null}::uuid)`;
      if (explicit && !tasks.length) throw new OpeningPlanError("NOT_FOUND", "task not found");
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
        if (explicit && ref.version !== explicit.expectedVersion) throw new OpeningPlanError("CONFLICT", "task version is stale");
        const activity = activityByTask.get(ref.id);
        const effectiveDueAt = currentDueAt(task, activity, now);
        if (!effectiveDueAt) {
          if (explicit) throw new OpeningPlanError("VALIDATION", "task is not currently due");
          continue;
        }
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
          timeZone: workspaceTimeZone,
          ...(explicit ? { explicitDue: true } : {}),
        };
        const key = reminderIdempotencyKey({
          taskId: ref.id, version: ref.version, dueAt: effectiveDueAt, channel: input.channel,
        });
        const rows = await sql.begin(async (tx) => {
          await lockLearningOwner(tx, scope);
          if (activity) {
            if (!activity.courseId) {
              if (explicit) throw new OpeningPlanError("NOT_FOUND", "retest course not found");
              return null;
            }
            await lockLearningPreferences(tx, scope, activity.courseId);
          }
          // Match task completion/submission: preference locks, then activity, then task.
          const currentActivities = await tx`SELECT * FROM opening_retest_activities
            WHERE task_id=${ref.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
          const currentActivity = currentActivities[0] ? mapOpeningRetestActivity(currentActivities[0] as Record<string, unknown>) : undefined;
          if (currentActivity?.activityId !== activity?.activityId || currentActivity?.courseId !== activity?.courseId) {
            if (explicit) throw new OpeningPlanError("CONFLICT", "task activity changed");
            return null;
          }
          const [currentTask] = await tx`SELECT id,title,due_at,status,version FROM opening_tasks
            WHERE id=${ref.id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
          if (!currentTask) {
            if (explicit) throw new OpeningPlanError("NOT_FOUND", "task not found");
            return null;
          }
          if (Number(currentTask.version) !== ref.version) {
            if (explicit) throw new OpeningPlanError("CONFLICT", "task version is stale");
            return null;
          }
          if (currentDueAt(currentTask, currentActivity, now) !== effectiveDueAt) {
            if (explicit) throw new OpeningPlanError("VALIDATION", "task is no longer currently due");
            return null;
          }
          if (!explicit && currentActivity && !(await automaticReminderAllowed(tx, scope, currentActivity))) return null;
          if (explicit && input.channel !== "in_app") {
            const currentConfig = await readConfig(tx, scope);
            if (!externalChannelConfigured(currentConfig) || currentConfig?.recipientId !== scope.ownerUserId) {
              throw new OpeningPlanError("VALIDATION", "external reminder channel is disabled");
            }
          }
          const [workspace] = await tx`SELECT privacy_epoch FROM workspaces
            WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
          return insertRemindJob(tx, scope, key, { ...payload, title: String(currentTask.title) }, Number(workspace!.privacy_epoch));
        });
        if (!rows) continue;
        queued.push({ ...mapReminder(rows.row, configured), created: rows.created });
      }
      return queued;
    },

    async getExternalConfig(scope: OpeningScope): Promise<ExternalReminderConfig | null> {
      return readConfig(sql, scope);
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
        const rows = await tx`SELECT j.payload, j.privacy_epoch, j.workspace_id AS job_workspace_id,
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
        const scope = { workspaceId: String(row.job_workspace_id), ownerUserId: String(row.job_owner_user_id) };
        await lockLearningOwner(tx, scope);
        const [workspace] = await tx`SELECT privacy_epoch FROM workspaces
          WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (Number(workspace!.privacy_epoch) !== Number(row.privacy_epoch)) return false;
        if (activity) {
          if (!activity.courseId) return false;
          await lockLearningPreferences(tx, scope, activity.courseId);
          if (!payload.explicitDue && !(await automaticReminderAllowed(tx, scope, activity, id))) return false;
        }
        // Recheck after the preference locks using the same activity/task order as enqueue.
        const currentActivities = await tx`SELECT * FROM opening_retest_activities
          WHERE task_id=${payload.taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        const currentActivity = currentActivities[0] ? mapOpeningRetestActivity(currentActivities[0] as Record<string, unknown>) : undefined;
        if (currentActivity?.activityId !== activity?.activityId || currentActivity?.courseId !== activity?.courseId) return false;
        const [task] = await tx`SELECT id,title,due_at,status,version FROM opening_tasks
          WHERE id=${payload.taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
        return Number(task?.version) === payload.taskVersion && currentDueAt(task, currentActivity, now) === payload.dueAt;
      }) as Promise<boolean>;
    },

    async recordAttempt(
      id: string,
      input: { receiptId: string | null; outcome: ReminderPayload["outcome"]; state: "succeeded" | "failed" | "outcome_unknown" | "queued"; suppressed?: boolean; availableAt?: string },
    ): Promise<boolean> {
      return sql.begin(async tx => {
        const rows = await tx`
        UPDATE opening_jobs
        SET state = ${input.state},
            payload = payload || ${tx.json({ receiptId: input.receiptId, outcome: input.outcome, suppressed: input.suppressed ?? false } as never)},
            result = ${tx.json({ receiptId: input.receiptId, outcome: input.outcome } as never)},
            updated_at = now()
        WHERE id = ${id} AND state = 'running' AND kind = ${"remind"}
        RETURNING id,workspace_id`;
        if (!rows.length) return false;
        if (input.state === "queued") {
          await enqueueReminderTransport(tx, String(rows[0]!.workspace_id), id, input.availableAt);
        }
        return true;
      });
    },
  };
}


async function readPlanningTimeZone(sql: Sql | TransactionSql, scope: OpeningScope): Promise<string> {
  const rows = await sql`
    SELECT planning_settings FROM workspace_preferences WHERE workspace_id = ${scope.workspaceId}
  `;
  const raw = rows[0]?.planning_settings;
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const tz = (raw as Record<string, unknown>).timeZone;
    if (typeof tz === "string" && tz.trim().length > 0) {
      return resolveWorkspaceTimeZone(tz);
    }
  }
  return DEFAULT_WORKSPACE_TIME_ZONE;
}

async function readConfig(sql: Sql | TransactionSql, scope: OpeningScope): Promise<ExternalReminderConfig | null> {
  const rows = await sql`
    SELECT payload FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      AND key = ${EXTERNAL_KEY} AND kind = ${"remind"} LIMIT 1`;
  if (!rows.length) return null;
  const raw: unknown = rows[0]!.payload;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  if (typeof payload.enabled !== "boolean" || !(payload.recipientId === null || typeof payload.recipientId === "string")) return null;
  const quiet = payload.quietHours;
  if (quiet !== null && (!quiet || typeof quiet !== "object" || Array.isArray(quiet))) return null;
  const hours = quiet as Record<string, unknown> | null;
  const minute = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1440;
  if (hours !== null && (!minute(hours.startMinute) || !minute(hours.endMinute))) return null;
  return {
    enabled: payload.enabled,
    recipientId: payload.recipientId,
    quietHours: hours === null ? null : { startMinute: hours.startMinute as number, endMinute: hours.endMinute as number },
  };
}

async function insertRemindJob(sql: Sql | TransactionSql, scope: OpeningScope, key: string, payload: ReminderPayload, privacyEpoch: number) {
  const inserted = await sql`
    INSERT INTO opening_jobs (
      id, workspace_id, owner_user_id, key, kind, payload, state, privacy_epoch
    ) VALUES (
      ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${key}, ${"remind"},
      ${sql.json(payload as never)}, ${"queued"}, ${privacyEpoch}
    )
    ON CONFLICT (workspace_id, key) DO NOTHING
    RETURNING *`;
  if (inserted.length) {
    const row = inserted[0] as Record<string, unknown>;
    await enqueueReminderTransport(sql, scope.workspaceId, String(row.id));
    return { row, created: true };
  }
  const existing = await sql`
    SELECT * FROM opening_jobs
    WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
      AND key = ${key} AND kind = ${"remind"} FOR UPDATE`;
  const row = existing[0] as Record<string, unknown> | undefined;
  if (!row) throw new OpeningPlanError("NOT_FOUND", "reminder disappeared after conflict");
  const previous = row.payload as ReminderPayload;
  if (payload.explicitDue && !previous.receiptId && previous.outcome !== "unknown" && row.state !== "outcome_unknown") {
    if (row.state === "running" && !previous.explicitDue) {
      throw new OpeningPlanError("CONFLICT", "automatic reminder is already running");
    }
    const recover = row.state === "succeeded" && previous.suppressed === true && previous.outcome == null;
    const promote = row.state === "queued" || row.state === "succeeded" && payload.channel === "in_app";
    if (recover || promote) {
      const [updated] = await sql`UPDATE opening_jobs SET
          payload=payload || ${sql.json({ explicitDue: true, suppressed: false, configured: payload.configured, clientKey: payload.clientKey } as never)},
          state=${recover ? "queued" : String(row.state)}, privacy_epoch=${privacyEpoch}, updated_at=now()
        WHERE id=${row.id as string} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        RETURNING *`;
      if (recover) await enqueueReminderTransport(sql, scope.workspaceId, String(row.id));
      else if (row.state === "queued" && (previous.outcome == null || previous.outcome === "quiet")) {
        // Pre-outbox reminder rows can only be repaired by this explicit, locked request.
        const events = await sql`SELECT id FROM opening_outbox
          WHERE workspace_id=${scope.workspaceId} AND job_id=${row.id as string} LIMIT 1`;
        if (!events.length) await enqueueReminderTransport(sql, scope.workspaceId, String(row.id));
      }
      return { row: updated as Record<string, unknown>, created: false };
    }
  }
  return { row, created: false };
}

async function enqueueReminderTransport(sql: Sql | TransactionSql, workspaceId: string, jobId: string, availableAt?: string) {
  await sql`INSERT INTO opening_outbox (workspace_id,job_id,topic,payload)
    VALUES (${workspaceId},${jobId},'opening.job.enqueue',${sql.json({ jobId, kind: "remind", ...(availableAt ? { availableAt } : {}) } as never)})`;
}

export type OpeningReminderRepository = ReturnType<typeof createOpeningReminderRepository>;
