import { randomUUID } from "node:crypto";
import type { RetestActivity } from "@aistudy/contracts";
import { isRetestActivityDue, transitionRetestActivity, type RetestActivityCommand } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { retestActivitySchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";

export type CreateRetestActivityInput = {
  activityId?: string;
  cycleId: string;
  candidateId?: string | null;
  taskId?: string | null;
  courseId: string;
  skillLabel: string;
  requirementKey?: string | null;
  proposedAt?: string | null;
  notBeforeAt?: string | null;
  recommendedAt?: string | null;
  scheduledStartAt?: string | null;
  deadlineAt?: string | null;
};

type ActivityRow = Record<string, unknown>;
const iso = (value: unknown) => value == null ? null : new Date(value as string | Date).toISOString();

export function mapOpeningRetestActivity(row: ActivityRow): RetestActivity {
  return retestActivitySchema.parse({
    activityId: String(row.id), cycleId: String(row.evidence_cycle_id),
    courseId: String(row.course_id), skillLabel: String(row.skill_label),
    requirementKey: row.requirement_key == null ? null : String(row.requirement_key), purpose: "retest",
    status: row.status, result: row.result ?? null, taskId: row.task_id ?? null, candidateId: row.candidate_id ?? null,
    version: Number(row.version), snoozedUntil: iso(row.snoozed_until), reason: row.reason ?? null,
    reopenedFromActivityId: row.reopened_from_activity_id ?? null,
    times: {
      proposedAt: iso(row.proposed_at), acceptedAt: iso(row.accepted_at), startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at), declinedAt: iso(row.declined_at), cancelledAt: iso(row.cancelled_at),
      invalidatedAt: iso(row.invalidated_at), supersededAt: iso(row.superseded_at), notBeforeAt: iso(row.not_before_at),
      recommendedAt: iso(row.recommended_at), scheduledStartAt: iso(row.scheduled_start_at), deadlineAt: iso(row.deadline_at),
    },
  });
}

async function readLocked(tx: TransactionSql, scope: OpeningScope, id: string): Promise<RetestActivity> {
  const rows = await tx`SELECT * FROM opening_retest_activities WHERE id=${id}
    AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "retest activity not found");
  return mapOpeningRetestActivity(rows[0] as ActivityRow);
}

async function persist(tx: TransactionSql, scope: OpeningScope, activity: RetestActivity): Promise<RetestActivity> {
  const t = activity.times;
  const rows = await tx`UPDATE opening_retest_activities SET
    status=${activity.status}, result=${activity.result}, task_id=${activity.taskId}, version=${activity.version},
    snoozed_until=${activity.snoozedUntil}, proposed_at=${t.proposedAt}, accepted_at=${t.acceptedAt}, started_at=${t.startedAt},
    completed_at=${t.completedAt}, declined_at=${t.declinedAt}, cancelled_at=${t.cancelledAt}, invalidated_at=${t.invalidatedAt},
    superseded_at=${t.supersededAt}, not_before_at=${t.notBeforeAt}, recommended_at=${t.recommendedAt},
    scheduled_start_at=${t.scheduledStartAt}, deadline_at=${t.deadlineAt}, reopened_from_activity_id=${activity.reopenedFromActivityId},
    reason=${activity.reason}, updated_at=now()
    WHERE id=${activity.activityId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    RETURNING *`;
  if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "retest activity disappeared");
  return mapOpeningRetestActivity(rows[0] as ActivityRow);
}

/** Coordinates a task mutation with its single linked retest activity. */
export async function transitionRetestActivityForTask(
  tx: TransactionSql,
  scope: OpeningScope,
  taskId: string,
  command: RetestActivityCommand,
): Promise<RetestActivity | null> {
  const rows = await tx`SELECT * FROM opening_retest_activities
    WHERE task_id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!rows.length) return null;
  const current = mapOpeningRetestActivity(rows[0] as ActivityRow);
  return persist(tx, scope, transitionRetestActivity(current, command));
}

async function readByAcceptanceIdentity(
  tx: TransactionSql,
  scope: OpeningScope,
  input: { candidateId?: string | null; taskId: string },
): Promise<ActivityRow[]> {
  if (input.candidateId != null) {
    return await tx`SELECT * FROM opening_retest_activities
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND candidate_id=${input.candidateId} FOR UPDATE` as ActivityRow[];
  }
  return await tx`SELECT * FROM opening_retest_activities
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND task_id=${input.taskId} FOR UPDATE` as ActivityRow[];
}

export async function insertAcceptedRetestActivity(
  tx: TransactionSql, scope: OpeningScope, input: CreateRetestActivityInput & { taskId: string; acceptedAt: string },
): Promise<RetestActivity> {
  const existing = await readByAcceptanceIdentity(tx, scope, input);
  if (existing.length) {
    const current = mapOpeningRetestActivity(existing[0] as ActivityRow);
    if (current.status === "accepted" && current.taskId === input.taskId) return current;
    if (current.status !== "proposed") throw new OpeningPlanError("CONFLICT", "retest activity is no longer open");
    return persist(tx, scope, transitionRetestActivity(current, { type: "accept", at: input.acceptedAt, taskId: input.taskId }));
  }
  const id = input.activityId ?? randomUUID();
  await tx`INSERT INTO opening_retest_activities (
    id, workspace_id, owner_user_id, course_id, skill_label, requirement_key, purpose, evidence_cycle_id,
    candidate_id, task_id, status, version, proposed_at, accepted_at, not_before_at, recommended_at, scheduled_start_at, deadline_at
  ) VALUES (
    ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.courseId}, ${input.skillLabel}, ${input.requirementKey ?? null}, 'retest', ${input.cycleId},
    ${input.candidateId ?? null}, ${input.taskId}, 'accepted', 2, ${input.proposedAt ?? input.acceptedAt}, ${input.acceptedAt},
    ${input.notBeforeAt ?? null}, ${input.recommendedAt ?? null}, ${input.scheduledStartAt ?? null}, ${input.deadlineAt ?? null}
  ) ON CONFLICT DO NOTHING`;
  const rows = await readByAcceptanceIdentity(tx, scope, input);
  if (!rows.length) throw new OpeningPlanError("CONFLICT", "retest activity was not created");
  return mapOpeningRetestActivity(rows[0] as ActivityRow);
}

export function createOpeningRetestActivityRepository(sql: Sql) {
  return {
    async createProposed(scope: OpeningScope, input: CreateRetestActivityInput): Promise<RetestActivity> {
      return sql.begin(async (tx) => {
        const existing = await tx`SELECT * FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND course_id=${input.courseId} AND skill_label=${input.skillLabel}
          AND requirement_key IS NOT DISTINCT FROM ${input.requirementKey ?? null} AND purpose='retest'
          AND evidence_cycle_id=${input.cycleId} FOR UPDATE`;
        if (existing.length) return mapOpeningRetestActivity(existing[0] as ActivityRow);
        const id = input.activityId ?? randomUUID();
        const rows = await tx`INSERT INTO opening_retest_activities (
          id, workspace_id, owner_user_id, course_id, skill_label, requirement_key, purpose, evidence_cycle_id, candidate_id, task_id,
          status, version, proposed_at, not_before_at, recommended_at, scheduled_start_at, deadline_at
        ) VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${input.courseId},${input.skillLabel},${input.requirementKey ?? null},'retest',${input.cycleId},
          ${input.candidateId ?? null},${input.taskId ?? null},'proposed',1,${input.proposedAt ?? null},${input.notBeforeAt ?? null},${input.recommendedAt ?? null},${input.scheduledStartAt ?? null},${input.deadlineAt ?? null})
          ON CONFLICT DO NOTHING RETURNING *`;
        if (rows.length) return mapOpeningRetestActivity(rows[0] as ActivityRow);
        const current = await tx`SELECT * FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} AND course_id=${input.courseId} AND skill_label=${input.skillLabel}
          AND requirement_key IS NOT DISTINCT FROM ${input.requirementKey ?? null} AND purpose='retest'
          AND evidence_cycle_id=${input.cycleId} FOR UPDATE`;
        if (!current.length) throw new OpeningPlanError("CONFLICT", "retest activity was not created");
        return mapOpeningRetestActivity(current[0] as ActivityRow);
      });
    },
    async get(scope: OpeningScope, activityId: string): Promise<RetestActivity> {
      const rows = await sql`SELECT * FROM opening_retest_activities WHERE id=${activityId}
        AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
      if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "retest activity not found");
      return mapOpeningRetestActivity(rows[0] as ActivityRow);
    },
    async accept(scope: OpeningScope, activityId: string, taskId: string, at: string): Promise<RetestActivity> {
      return this.transition(scope, activityId, { type: "accept", taskId, at });
    },
    async transition(scope: OpeningScope, activityId: string, command: RetestActivityCommand): Promise<RetestActivity> {
      return sql.begin(async (tx) => persist(tx, scope, transitionRetestActivity(await readLocked(tx, scope, activityId), command)));
    },
    async completeForTask(scope: OpeningScope, taskId: string, command: Extract<RetestActivityCommand, { type: "complete" }>): Promise<RetestActivity> {
      return sql.begin(async (tx) => {
        // Keep the activity -> task lock order shared with observation
        // submission and task status updates.
        const activities = await tx`SELECT * FROM opening_retest_activities
          WHERE task_id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!activities.length) throw new OpeningPlanError("NOT_FOUND", "retest activity for task not found");
        const tasks = await tx`SELECT id, status FROM opening_tasks
          WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!tasks.length) throw new OpeningPlanError("NOT_FOUND", "retest task not found");
        const completed = await transitionRetestActivityForTask(tx, scope, taskId, command);
        if (!completed) throw new OpeningPlanError("NOT_FOUND", "retest activity for task not found");
        if ((tasks[0] as ActivityRow).status !== "done") {
          await tx`UPDATE opening_tasks SET status='done', version=version + 1, updated_at=now()
            WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        }
        return completed;
      });
    },
    async listDue(scope: OpeningScope, courseId: string, now: string): Promise<RetestActivity[]> {
      const rows = await sql`SELECT a.* FROM opening_retest_activities a
        JOIN opening_tasks t ON t.id=a.task_id AND t.workspace_id=a.workspace_id AND t.owner_user_id=a.owner_user_id
          AND t.status='pending'
        WHERE a.workspace_id=${scope.workspaceId}
          AND a.owner_user_id=${scope.ownerUserId} AND a.course_id=${courseId}
          AND a.status IN ('accepted','in_progress')
          AND COALESCE(a.scheduled_start_at,a.recommended_at) IS NOT NULL
          AND COALESCE(a.scheduled_start_at,a.recommended_at) <= ${now}
          AND (a.not_before_at IS NULL OR a.not_before_at <= ${now})
          AND (a.snoozed_until IS NULL OR a.snoozed_until <= ${now})
        ORDER BY COALESCE(a.scheduled_start_at,a.recommended_at), a.id`;
      return rows.map((row) => mapOpeningRetestActivity(row as ActivityRow)).filter((item) => isRetestActivityDue(item, now));
    },
  };
}

export type OpeningRetestActivityRepository = ReturnType<typeof createOpeningRetestActivityRepository>;
