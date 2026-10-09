import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type {
  PlanDraft,
  PlannedBlock,
  TaskCreateInput,
  TaskCreateResult,
  TaskItem,
  TaskStatusUpdateInput,
  TimeBlock,
  WeekSession,
} from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import { insertOpeningTask } from "./opening-retest-task";
import { transitionRetestActivityForTask } from "./opening-retest-activities";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";

export { OpeningPlanError };
export type { OpeningPlanErrorCode } from "./opening-plan-error";

export type ProposePlanInput = {
  date: string;
  tasks: TaskItem[];
  free: TimeBlock[];
  blocks: PlannedBlock[];
  unscheduledTaskIds: string[];
  clientKey?: string | null;
};


function fingerprintHardBlocks(blocks: TimeBlock[]): string {
  const hard = blocks
    .filter((b) => b.kind !== "free")
    .map((b) => `${b.kind}:${b.start}:${b.end}`)
    .sort();
  return createHash("sha256").update(hard.join("|")).digest("hex");
}

/** Stable int4 pair for pg_advisory_xact_lock(workspace+date). */
export function dailyDraftAdvisoryLockKeys(workspaceId: string, date: string): [number, number] {
  const digest = createHash("sha256").update(`opening-daily-draft:${workspaceId}:${date}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function mapTask(row: Record<string, unknown>): TaskItem {
  const base: TaskItem = {
    id: row.id as string,
    version: Number(row.version),
    title: row.title as string,
    minutes: Number(row.minutes),
    dueAt: row.due_at ? new Date(row.due_at as string | Date).toISOString() : null,
    priority: Number(row.priority),
    status: row.status as TaskItem["status"],
    retest: null,
  };
  const activityId = row.retest_activity_id as string | null | undefined;
  if (!activityId) return base;
  const prompt = (row.retest_prompt as string | null | undefined) ?? base.title;
  return {
    ...base,
    retest: {
      candidateId: row.retest_candidate_id as string,
      activityId,
      courseId: row.retest_course_id as string,
      skillLabel: row.retest_skill_label as string,
      prompt,
      recommendedAt: row.retest_recommended_at
        ? new Date(row.retest_recommended_at as string | Date).toISOString()
        : null,
    },
  };
}

function formatPlanDay(value: unknown): string {
  if (value instanceof Date) {
    // DATE columns come back as local midnight; use UTC Y-M-D from the instant
    // postgres.js constructs for date-only values (UTC midnight of that day).
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const raw = String(value);
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1]!;
  throw new OpeningPlanError("VALIDATION", `invalid plan day: ${raw}`);
}

function mapDraft(row: Record<string, unknown>): PlanDraft {
  return {
    id: row.id as string,
    date: formatPlanDay(row.day),
    version: Number(row.version),
    baseVersion: Number(row.base_version),
    status: row.status as PlanDraft["status"],
    blocks: (row.blocks as PlannedBlock[]) ?? [],
    unscheduledTaskIds: (row.unscheduled_task_ids as string[]) ?? [],
  };
}

export function createOpeningPlansRepository(sql: Sql) {
  return {
    async listTasks(scope: OpeningScope): Promise<TaskItem[]> {
      const rows = await sql`
        SELECT
          t.*,
          a.id AS retest_activity_id,
          a.candidate_id AS retest_candidate_id,
          a.course_id AS retest_course_id,
          a.skill_label AS retest_skill_label,
          a.recommended_at AS retest_recommended_at,
          COALESCE(j.result->'inputSnapshot'->>'prompt', j.payload->>'prompt') AS retest_prompt
        FROM opening_tasks t
        LEFT JOIN opening_retest_activities a
          ON a.task_id = t.id
          AND a.workspace_id = t.workspace_id
          AND a.owner_user_id = t.owner_user_id
        LEFT JOIN opening_jobs j
          ON j.id = a.candidate_id
          AND j.workspace_id = t.workspace_id
        WHERE t.workspace_id = ${scope.workspaceId} AND t.owner_user_id = ${scope.ownerUserId}
        ORDER BY t.created_at ASC`;
      return rows.map((r) => mapTask(r as Record<string, unknown>));
    },

    async createTask(
      scope: OpeningScope,
      input: TaskCreateInput & { dueText?: string | null },
    ): Promise<TaskCreateResult> {
      return insertOpeningTask(sql, scope, input);
    },

    async updateTaskStatus(scope: OpeningScope, taskId: string, input: TaskStatusUpdateInput): Promise<TaskItem> {
      return sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        // Lock the linked activity before the task. Observation submission and
        // task completion use the same order, so concurrent decisions cannot
        // deadlock while both try to reconcile the pair.
        const activityRows = await tx`SELECT id, status, candidate_id FROM opening_retest_activities
          WHERE task_id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        const activity = activityRows[0] as Record<string, unknown> | undefined;
        const rows = await tx`SELECT * FROM opening_tasks
          WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "task not found");
        const current = rows[0] as Record<string, unknown>;
        const currentVersion = Number(current.version);
        if (currentVersion !== input.expectedVersion) throw new OpeningPlanError("CONFLICT", "task version is stale");
        if (current.status === input.status) return mapTask(current);

        if (activity && input.status === "skipped" && String(activity.status) === "completed") {
          throw new OpeningPlanError("CONFLICT", "completed retest activity cannot be skipped");
        }
        if (activity && input.status === "done" && ["cancelled", "declined", "invalidated", "superseded"].includes(String(activity.status))) {
          throw new OpeningPlanError("CONFLICT", "terminal retest activity cannot be completed by its task");
        }
        if (activity && input.status === "done" && ["accepted", "in_progress"].includes(String(activity.status))) {
          const retestIds = [activity.id, activity.candidate_id].filter((value): value is string => typeof value === "string");
          const observations = await tx`SELECT outcome FROM opening_learning_observations
            WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
              AND retest_id IN ${tx(retestIds)}
            ORDER BY occurred_at DESC, id DESC LIMIT 1`;
          const outcome = observations[0]?.outcome;
          await transitionRetestActivityForTask(tx, scope, taskId, {
            type: "complete",
            at: input.at,
            result: outcome === "correct" || outcome === "incorrect" || outcome === "unverified" ? outcome : undefined,
            hasObservation: observations.length > 0,
          });
        } else if (activity && input.status === "skipped" && ["accepted", "in_progress"].includes(String(activity.status))) {
          await transitionRetestActivityForTask(tx, scope, taskId, { type: "skip", at: input.at });
        }

        const updated = await tx`UPDATE opening_tasks SET status=${input.status}, version=version + 1, updated_at=now()
          WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          RETURNING *`;
        if (activity) await nextWorkspaceLearningHistoryRevision(tx, scope);
        return mapTask(updated[0] as Record<string, unknown>);
      });
    },

    async listTimetable(scope: OpeningScope): Promise<WeekSession[]> {
      const rows = await sql`
        SELECT * FROM opening_timetable_sessions
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
        ORDER BY weekday, start_period`;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          courseName: r.course_name as string,
          courseId: (r.course_id as string | null) ?? null,
          weekday: Number(r.weekday),
          weeks: (r.weeks as number[]) ?? [],
          startPeriod: Number(r.start_period),
          endPeriod: Number(r.end_period),
        };
      });
    },

    async replaceTimetable(scope: OpeningScope, sessions: WeekSession[]): Promise<WeekSession[]> {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM opening_timetable_sessions
          WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
        for (const s of sessions) {
          await tx`
            INSERT INTO opening_timetable_sessions (
              id, workspace_id, owner_user_id, course_name, course_id, weekday, weeks, start_period, end_period
            ) VALUES (
              ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${s.courseName},
              ${s.courseId ?? null}, ${s.weekday}, ${s.weeks}, ${s.startPeriod}, ${s.endPeriod}
            )`;
        }
      });
      return this.listTimetable(scope);
    },

    async listHardBlocks(scope: OpeningScope, day: string): Promise<TimeBlock[]> {
      const rows = await sql`
        SELECT start_at, end_at, kind FROM opening_hard_blocks
        WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
          AND day = ${day}::date`;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          start: new Date(r.start_at as string | Date).toISOString(),
          end: new Date(r.end_at as string | Date).toISOString(),
          kind: r.kind as TimeBlock["kind"],
        };
      });
    },

    async upsertHardBlocks(scope: OpeningScope, day: string, blocks: TimeBlock[]): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`DELETE FROM opening_hard_blocks
          WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
            AND day = ${day}::date`;
        for (const b of blocks.filter((x) => x.kind !== "free")) {
          await tx`
            INSERT INTO opening_hard_blocks (
              id, workspace_id, owner_user_id, day, start_at, end_at, kind
            ) VALUES (
              ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${day}::date,
              ${b.start}, ${b.end}, ${b.kind}
            )`;
        }
        const fp = fingerprintHardBlocks(blocks);
        await tx`
          INSERT INTO opening_plan_state (workspace_id, day, hard_blocks_fingerprint)
          VALUES (${scope.workspaceId}, ${day}::date, ${fp})
          ON CONFLICT (workspace_id, day) DO UPDATE
            SET hard_blocks_fingerprint = EXCLUDED.hard_blocks_fingerprint, updated_at = now()`;
      });
    },

    async getToday(scope: OpeningScope, day: string): Promise<{
      acceptedVersion: number;
      blocks: PlannedBlock[];
      hardBlocksFingerprint: string;
    } | null> {
      const rows = await sql`
        SELECT accepted_version, accepted_blocks, hard_blocks_fingerprint FROM opening_plan_state
        WHERE workspace_id = ${scope.workspaceId} AND day = ${day}::date`;
      if (!rows.length) return null;
      const r = rows[0] as Record<string, unknown>;
      return {
        acceptedVersion: Number(r.accepted_version),
        blocks: (r.accepted_blocks as PlannedBlock[]) ?? [],
        hardBlocksFingerprint: String(r.hard_blocks_fingerprint ?? ""),
      };
    },

    async proposePlan(scope: OpeningScope, input: ProposePlanInput): Promise<PlanDraft> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
        throw new OpeningPlanError("VALIDATION", "date must be YYYY-MM-DD (no invented dates)");
      }
      const state = await this.getToday(scope, input.date);
      const baseVersion = state?.acceptedVersion ?? 0;
      const fp = fingerprintHardBlocks(input.free);
      const id = randomUUID();
      const snapshot = {
        tasks: input.tasks,
        free: input.free,
        proposedAt: new Date().toISOString(),
      };
      const rows = await sql`
        INSERT INTO opening_plan_drafts (
          id, workspace_id, owner_user_id, day, version, base_version, status,
          blocks, unscheduled_task_ids, input_snapshot, hard_blocks_fingerprint, propose_client_key
        ) VALUES (
          ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.date}::date, ${0}, ${baseVersion},
          ${"draft"}, ${sql.json(input.blocks as never)}, ${sql.json(input.unscheduledTaskIds as never)},
          ${sql.json(snapshot as never)}, ${fp}, ${input.clientKey ?? null}
        ) RETURNING *`;
      return mapDraft(rows[0] as Record<string, unknown>);
    },

    async rejectPlan(scope: OpeningScope, draftId: string): Promise<PlanDraft> {
      const rows = await sql`
        UPDATE opening_plan_drafts SET status = 'rejected', updated_at = now()
        WHERE id = ${draftId} AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId} AND status = 'draft'
        RETURNING *`;
      if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "draft not found");
      return mapDraft(rows[0] as Record<string, unknown>);
    },

    async acceptPlan(
      scope: OpeningScope,
      input: { draftId: string; expectedBaseVersion: number; clientKey: string },
    ): Promise<PlanDraft> {
      const payloadHash = createHash("sha256")
        .update(JSON.stringify({ draftId: input.draftId, expectedBaseVersion: input.expectedBaseVersion }))
        .digest("hex");

      return sql.begin(async (tx) => {
        const existing = await tx`
          SELECT draft_id, payload_hash FROM opening_plan_acceptances
          WHERE workspace_id = ${scope.workspaceId} AND client_key = ${input.clientKey}
          FOR UPDATE`;
        if (existing.length) {
          const row = existing[0] as Record<string, unknown>;
          if (String(row.payload_hash) !== payloadHash) {
            throw new OpeningPlanError("CONFLICT", "clientKey payload differs");
          }
          const drafts = await tx`SELECT * FROM opening_plan_drafts WHERE id = ${row.draft_id as string}`;
          if (!drafts.length) throw new OpeningPlanError("NOT_FOUND", "accepted draft missing");
          return mapDraft(drafts[0] as Record<string, unknown>);
        }

        const drafts = await tx`
          SELECT * FROM opening_plan_drafts
          WHERE id = ${input.draftId} AND workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
          FOR UPDATE`;
        if (!drafts.length) throw new OpeningPlanError("NOT_FOUND", "draft not found");
        const draft = drafts[0] as Record<string, unknown>;
        if (draft.status !== "draft") {
          throw new OpeningPlanError("CONFLICT", "draft is not open");
        }
        const day = String(draft.day);

        await tx`SELECT workspace_id FROM opening_plan_state
          WHERE workspace_id = ${scope.workspaceId} AND day = ${day}::date
          FOR UPDATE`;
        const stateRows = await tx`
          SELECT accepted_version, hard_blocks_fingerprint FROM opening_plan_state
          WHERE workspace_id = ${scope.workspaceId} AND day = ${day}::date`;
        const acceptedVersion = stateRows.length
          ? Number((stateRows[0] as Record<string, unknown>).accepted_version)
          : 0;
        const currentFp = stateRows.length
          ? String((stateRows[0] as Record<string, unknown>).hard_blocks_fingerprint ?? "")
          : "";

        if (Number(draft.base_version) !== input.expectedBaseVersion) {
          throw new OpeningPlanError("CONFLICT", "stale expectedBaseVersion");
        }
        if (acceptedVersion !== Number(draft.base_version)) {
          throw new OpeningPlanError("CONFLICT", "stale draft baseVersion");
        }
        if (currentFp && currentFp !== String(draft.hard_blocks_fingerprint)) {
          throw new OpeningPlanError("CONFLICT", "hard blocks changed; draft stale");
        }

        const nextVersion = acceptedVersion + 1;
        const blocks = (draft.blocks as PlannedBlock[]) ?? [];
        await tx`
          INSERT INTO opening_plan_state (
            workspace_id, day, accepted_version, accepted_blocks, hard_blocks_fingerprint
          ) VALUES (
            ${scope.workspaceId}, ${day}::date, ${nextVersion}, ${tx.json(blocks as never)},
            ${String(draft.hard_blocks_fingerprint)}
          )
          ON CONFLICT (workspace_id, day) DO UPDATE SET
            accepted_version = EXCLUDED.accepted_version,
            accepted_blocks = EXCLUDED.accepted_blocks,
            hard_blocks_fingerprint = EXCLUDED.hard_blocks_fingerprint,
            updated_at = now()`;

        const updated = await tx`
          UPDATE opening_plan_drafts
          SET status = 'accepted', version = ${nextVersion}, updated_at = now()
          WHERE id = ${input.draftId}
          RETURNING *`;

        await tx`
          INSERT INTO opening_plan_acceptances (
            workspace_id, client_key, draft_id, day, accepted_version, payload_hash
          ) VALUES (
            ${scope.workspaceId}, ${input.clientKey}, ${input.draftId}, ${day}::date,
            ${nextVersion}, ${payloadHash}
          )`;

        return mapDraft(updated[0] as Record<string, unknown>);
      });
    },

    async findDraftByProposeClientKey(
      scope: OpeningScope,
      day: string,
      clientKey: string,
    ): Promise<PlanDraft | null> {
      const rows = await sql`
        SELECT * FROM opening_plan_drafts
        WHERE workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId}
          AND day = ${day}::date
          AND propose_client_key = ${clientKey}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`;
      if (!rows.length) return null;
      return mapDraft(rows[0] as Record<string, unknown>);
    },

    /**
     * Idempotent daily auto-draft: advisory xact lock → skip if accepted/rejected →
     * return existing draft or insert one from `build`.
     */
    async ensureAutoDraft(
      scope: OpeningScope,
      day: string,
      clientKey: string,
      build: () => Promise<
        | { kind: "propose"; input: ProposePlanInput }
        | { kind: "skip"; reason: "no_settings" }
      >,
      countUnplannedPending: () => Promise<number>,
    ): Promise<{
      draft: PlanDraft | null;
      skippedBecauseAccepted: boolean;
      dailyDraftSkippedReason: "accepted" | "rejected" | "no_settings" | null;
      unplannedPendingCount?: number;
    }> {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new OpeningPlanError("VALIDATION", "date must be YYYY-MM-DD");
      }
      const [lockA, lockB] = dailyDraftAdvisoryLockKeys(scope.workspaceId, day);
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${lockA}, ${lockB})`;

        const stateRows = await tx`
          SELECT accepted_version, accepted_blocks FROM opening_plan_state
          WHERE workspace_id = ${scope.workspaceId} AND day = ${day}::date`;
        const acceptedVersion = stateRows.length
          ? Number((stateRows[0] as Record<string, unknown>).accepted_version)
          : 0;
        if (acceptedVersion > 0) {
          const unplannedPendingCount = await countUnplannedPending();
          return {
            draft: null,
            skippedBecauseAccepted: true,
            dailyDraftSkippedReason: "accepted" as const,
            unplannedPendingCount,
          };
        }

        const existingRows = await tx`
          SELECT * FROM opening_plan_drafts
          WHERE workspace_id = ${scope.workspaceId}
            AND owner_user_id = ${scope.ownerUserId}
            AND day = ${day}::date
            AND propose_client_key = ${clientKey}
          ORDER BY created_at DESC, id DESC
          LIMIT 1`;
        if (existingRows.length) {
          const existing = mapDraft(existingRows[0] as Record<string, unknown>);
          if (existing.status === "rejected") {
            return {
              draft: null,
              skippedBecauseAccepted: false,
              dailyDraftSkippedReason: "rejected" as const,
            };
          }
          if (existing.status === "accepted") {
            const unplannedPendingCount = await countUnplannedPending();
            return {
              draft: null,
              skippedBecauseAccepted: true,
              dailyDraftSkippedReason: "accepted" as const,
              unplannedPendingCount,
            };
          }
          return {
            draft: existing,
            skippedBecauseAccepted: false,
            dailyDraftSkippedReason: null,
          };
        }

        const built = await build();
        if (built.kind === "skip") {
          return {
            draft: null,
            skippedBecauseAccepted: false,
            dailyDraftSkippedReason: built.reason,
          };
        }

        const input = built.input;
        // Persist hard blocks (non-free) for the day inside this transaction.
        await tx`DELETE FROM opening_hard_blocks
          WHERE workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}
            AND day = ${day}::date`;
        for (const b of input.free.filter((x) => x.kind !== "free")) {
          await tx`
            INSERT INTO opening_hard_blocks (
              id, workspace_id, owner_user_id, day, start_at, end_at, kind
            ) VALUES (
              ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${day}::date,
              ${b.start}, ${b.end}, ${b.kind}
            )`;
        }
        const fp = fingerprintHardBlocks(input.free);
        await tx`
          INSERT INTO opening_plan_state (workspace_id, day, hard_blocks_fingerprint)
          VALUES (${scope.workspaceId}, ${day}::date, ${fp})
          ON CONFLICT (workspace_id, day) DO UPDATE
            SET hard_blocks_fingerprint = EXCLUDED.hard_blocks_fingerprint, updated_at = now()`;

        const baseVersion = 0;
        const id = randomUUID();
        const snapshot = {
          tasks: input.tasks,
          free: input.free,
          proposedAt: new Date().toISOString(),
          autoDraft: true,
        };
        const rows = await tx`
          INSERT INTO opening_plan_drafts (
            id, workspace_id, owner_user_id, day, version, base_version, status,
            blocks, unscheduled_task_ids, input_snapshot, hard_blocks_fingerprint, propose_client_key
          ) VALUES (
            ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${day}::date, ${0}, ${baseVersion},
            ${"draft"}, ${tx.json(input.blocks as never)}, ${tx.json(input.unscheduledTaskIds as never)},
            ${tx.json(snapshot as never)}, ${fp}, ${clientKey}
          ) RETURNING *`;
        return {
          draft: mapDraft(rows[0] as Record<string, unknown>),
          skippedBecauseAccepted: false,
          dailyDraftSkippedReason: null,
        };
      });
    },
  };
}

export type OpeningPlansRepository = ReturnType<typeof createOpeningPlansRepository>;
