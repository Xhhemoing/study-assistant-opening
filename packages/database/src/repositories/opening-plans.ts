import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type {
  AcceptPlanInput,
  PlanBlockReason,
  PlanDraft,
  PlanDraftOrigin,
  PlannedBlock,
  SuggestedTask,
  TaskCreateInput,
  TaskCreateResult,
  TaskDeferInput,
  TaskItem,
  TaskStatusUpdateInput,
  TimeBlock,
  WeekSession,
} from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { OpeningPlanError } from "./opening-plan-error";
import { insertOpeningTask, insertOpeningTaskWithOutcome, type TaskCreateOutcome } from "./opening-retest-task";
import { transitionRetestActivityForTask } from "./opening-retest-activities";
import { lockWorkspaceLearningHistory, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { withTaskPlanningFields } from "./opening-task-fields";
import { recordOpeningPlanFeedback } from "./opening-plan-feedback";

import { recordOpeningPlanDraftDecision } from "./opening-plan-decision";

import { acceptOpeningPlan } from "./opening-plan-accept";

export { OpeningPlanError };
export type { OpeningPlanErrorCode } from "./opening-plan-error";

export type ProposePlanInput = {
  date: string;
  tasks: TaskItem[];
  free: TimeBlock[];
  blocks: PlannedBlock[];
  unscheduledTaskIds: string[];
  unscheduledReasons?: Array<{ taskId: string; reason: string }>;
  clientKey?: string | null;
};

/** Adaptive auto draft (OPENING_ADAPTIVE_PLANNING): suggestions, reasons and what they were built from. */
export type AdaptiveDraftInput = {
  suggestedTasks: SuggestedTask[];
  reasons: Record<string, PlanBlockReason>;
  strategyVersion: string;
  /** Hash of the learner snapshot sources the suggestions came from. */
  plannerInputRevision: string;
  /** Present in production so a removed/archived course makes an open draft non-executable. */
  availableCourseIds?: string[];
  courseMaterialRevisions?: Record<string, string>;
};

export type AutoDraftBuild =
  | { kind: "propose"; input: ProposePlanInput; adaptive?: AdaptiveDraftInput; fallbackReason?: string }
  | { kind: "skip"; reason: "no_settings" };

export type EnsureAutoDraftOptions = {
  /** Replace an open adaptive draft whose suggestions are out of date (learner asked to refresh). */
  refreshSuggestions?: boolean;
  now?: Date;
};


export function fingerprintHardBlocks(blocks: TimeBlock[]): string {
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
  if (!activityId) return withTaskPlanningFields(base, row);
  const prompt = (row.retest_prompt as string | null | undefined) ?? base.title;
  return withTaskPlanningFields({
    ...base,
    retest: {
      candidateId: row.retest_candidate_id as string,
      activityId,
      courseId: row.retest_course_id as string,
      skillLabel: row.retest_skill_label as string,
      ...(typeof row.retest_requirement_key === "string" ? { requirementKey: row.retest_requirement_key } : {}),
      prompt,
      recommendedAt: row.retest_recommended_at
        ? new Date(row.retest_recommended_at as string | Date).toISOString()
        : null,
    },
  }, row);
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

export function mapOpeningPlanDraft(row: Record<string, unknown>): PlanDraft {
  const draft: PlanDraft = {
    id: row.id as string,
    date: formatPlanDay(row.day),
    version: Number(row.version),
    baseVersion: Number(row.base_version),
    status: row.status as PlanDraft["status"],
    blocks: (row.blocks as PlannedBlock[]) ?? [],
    unscheduledTaskIds: (row.unscheduled_task_ids as string[]) ?? [],
  };
  // 0061 fields are omitted at their defaults so plain drafts keep their shape.
  if (typeof row.origin === "string" && row.origin !== "user") draft.origin = row.origin as PlanDraftOrigin;
  const suggested = row.suggested_tasks as SuggestedTask[] | null | undefined;
  if (Array.isArray(suggested) && suggested.length) draft.suggestedTasks = suggested;
  const reasons = row.reasons as Record<string, PlanBlockReason> | null | undefined;
  if (reasons && Object.keys(reasons).length) draft.reasons = reasons;
  if (typeof row.strategy_version === "string") draft.strategyVersion = row.strategy_version;
  return draft;
}

export function createOpeningPlansRepository(sql: Sql, options: { now?: () => Date } = {}) {
  return {
    async listTasks(scope: OpeningScope): Promise<TaskItem[]> {
      const rows = await sql`
        SELECT
          t.*,
          target.id AS teaching_activity_id,
          target.course_id AS teaching_course_id,
          target.goal_json AS teaching_goal_json,
          a.id AS retest_activity_id,
          a.candidate_id AS retest_candidate_id,
          a.course_id AS retest_course_id,
          a.skill_label AS retest_skill_label,
          a.requirement_key AS retest_requirement_key,
          a.recommended_at AS retest_recommended_at,
          COALESCE(j.result->'inputSnapshot'->>'prompt', j.payload->>'prompt') AS retest_prompt
        FROM opening_tasks t
        JOIN workspaces w ON w.id = t.workspace_id AND w.owner_user_id = t.owner_user_id
        LEFT JOIN LATERAL (
          SELECT teaching.id, teaching.course_id, teaching.goal_json
          FROM opening_teaching_activities teaching
          JOIN courses c ON c.id = teaching.course_id AND c.workspace_id = t.workspace_id AND c.archived_at IS NULL
          WHERE teaching.workspace_id = t.workspace_id AND teaching.owner_user_id = t.owner_user_id
            AND teaching.course_id = t.course_id AND teaching.status IN ('active', 'paused')
            AND (
              -- Use the stored task intent, never an accidental task-looking client key.
              (teaching.create_intent->>'source' = 'task' AND lower(teaching.create_intent->>'taskId') = t.id::text)
              OR (t.origin IN ('manual', 'course_seed') AND t.client_key = 'first-learning-activity:' || teaching.id::text
                AND teaching.create_intent->>'source' = 'onboarding' AND teaching.client_key LIKE 'first-learning:%')
            )
          ORDER BY teaching.updated_at DESC, teaching.id ASC
          LIMIT 1
        ) target ON true
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

    /** Same write as createTask; also reports whether a clientKey replay returned an existing task. */
    async createTaskWithOutcome(
      scope: OpeningScope,
      input: TaskCreateInput & { dueText?: string | null },
    ): Promise<TaskCreateOutcome> {
      return insertOpeningTaskWithOutcome(sql, scope, input);
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

        const updated = await tx`UPDATE opening_tasks SET status=${input.status}, close_source='learner', version=version + 1, updated_at=now()
          WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
          RETURNING *`;
        await recordOpeningPlanFeedback(tx, scope, updated[0] as Record<string, unknown>, input.status, input.feedback);
        if (activity) await nextWorkspaceLearningHistoryRevision(tx, scope);
        return mapTask(updated[0] as Record<string, unknown>);
      });
    },

    /** Defer (or un-defer) a pending task; planners skip it until notBefore. */
    async deferTask(scope: OpeningScope, taskId: string, input: TaskDeferInput): Promise<TaskItem> {
      return sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        const rows = await tx`SELECT * FROM opening_tasks
          WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "task not found");
        const current = rows[0] as Record<string, unknown>;
        if (current.status !== "pending") throw new OpeningPlanError("CONFLICT", "only pending tasks can be deferred");
        if (Number(current.version) !== input.expectedVersion) throw new OpeningPlanError("CONFLICT", "task version is stale");
        const readTask = async () => {
          const tasks = await createOpeningPlansRepository(tx as unknown as Sql).listTasks(scope);
          return tasks.find((item) => item.id === String(current.id))!;
        };
        const before = current.not_before ? new Date(current.not_before as string | Date).getTime() : null;
        const after = input.notBefore === null ? null : new Date(input.notBefore).getTime();
        if (before === after) return readTask();
        const updated = await tx`UPDATE opening_tasks
          SET not_before=${input.notBefore}, version=version + 1, updated_at=now()
          WHERE id=${taskId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} RETURNING *`;
        await recordOpeningPlanFeedback(tx, scope, updated[0] as Record<string, unknown>,
          input.notBefore === null ? "resumed" : "deferred", input.feedback);
        // Keep the retest projection and read the response under the same transaction.
        return readTask();
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
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
          AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
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
        const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owners.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
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
        unscheduledReasons: input.unscheduledReasons ?? [],
      };
      return sql.begin(async tx => {
        const rows = await tx`
          INSERT INTO opening_plan_drafts (
            id, workspace_id, owner_user_id, day, version, base_version, status,
            blocks, unscheduled_task_ids, input_snapshot, hard_blocks_fingerprint, propose_client_key
          ) VALUES (
            ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${input.date}::date, ${0}, ${baseVersion},
            ${"draft"}, ${tx.json(input.blocks as never)}, ${tx.json(input.unscheduledTaskIds as never)},
            ${tx.json(snapshot as never)}, ${fp}, ${input.clientKey ?? null}
          ) RETURNING *`;
        const draft = mapOpeningPlanDraft(rows[0] as Record<string, unknown>);
        await recordOpeningPlanDraftDecision(tx, scope, draft, input.unscheduledReasons);
        return draft;
      }) as Promise<PlanDraft>;
    },

    async rejectPlan(scope: OpeningScope, draftId: string): Promise<PlanDraft> {
      const rows = await sql`
        UPDATE opening_plan_drafts SET status = 'rejected', updated_at = now()
        WHERE id = ${draftId} AND workspace_id = ${scope.workspaceId}
          AND owner_user_id = ${scope.ownerUserId} AND status = 'draft'
        RETURNING *`;
      if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "draft not found");
      return mapOpeningPlanDraft(rows[0] as Record<string, unknown>);
    },

    async acceptPlan(scope: OpeningScope, input: AcceptPlanInput): Promise<PlanDraft> {
      return mapOpeningPlanDraft(await acceptOpeningPlan(sql, scope, input, options.now?.() ?? new Date()));
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
      return mapOpeningPlanDraft(rows[0] as Record<string, unknown>);
    },

    /**
     * Idempotent daily auto-draft: advisory xact lock → skip if accepted/rejected →
     * return existing draft or insert one from `build`.
     */
    async ensureAutoDraft(
      scope: OpeningScope,
      day: string,
      clientKey: string,
      build: () => Promise<AutoDraftBuild>,
      countUnplannedPending: () => Promise<number>,
      options: EnsureAutoDraftOptions = {},
    ): Promise<{
      draft: PlanDraft | null;
      skippedBecauseAccepted: boolean;
      dailyDraftSkippedReason: "accepted" | "rejected" | "no_settings" | null;
      unplannedPendingCount?: number;
      /** The open draft is still executable but newer suggestions exist. */
      hasNewerSuggestion?: boolean;
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
        let supersede: string | null = null;
        let prebuilt: AutoDraftBuild | null = null;
        if (existingRows.length) {
          const existing = mapOpeningPlanDraft(existingRows[0] as Record<string, unknown>);
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
          // PR-B: an unconfirmed auto draft is recomputed when its inputs changed or it
          // predates the local-day fix (no algo marker). Unchanged -> keep it (stable id); else the old row
          // is superseded (status 'rejected' + input_snapshot.supersededBy, no schema
          // change) and a fresh draft is inserted. The advisory lock above serializes
          // concurrent callers, so at most one 'draft' row exists per day/clientKey.
          // Accepted plans never reach here (acceptedVersion / status checks above).
          const rebuilt = await build();
          if (rebuilt.kind === "skip") {
            return { draft: null, skippedBecauseAccepted: false, dailyDraftSkippedReason: rebuilt.reason };
          }
          const stored = (existingRows[0] as Record<string, unknown>).input_snapshot;
          const expired = existing.strategyVersion && existing.blocks.some(block =>
            Date.parse(block.start) < (options.now ?? new Date()).getTime());
          const unavailableCourse = rebuilt.adaptive?.availableCourseIds !== undefined
            && existing.suggestedTasks?.some(task => task.courseId !== null
              && !rebuilt.adaptive!.availableCourseIds!.includes(task.courseId));
          const savedMaterials = (stored as { courseMaterialRevisions?: Record<string, string> } | null)?.courseMaterialRevisions;
          const materialsChanged = existing.suggestedTasks?.some(task => task.courseId !== null
            && (!savedMaterials?.[task.courseId]
              || savedMaterials[task.courseId] !== rebuilt.adaptive?.courseMaterialRevisions?.[task.courseId]));
          if (!expired && !unavailableCourse && !materialsChanged && autoDraftInputsUnchanged(stored, rebuilt)) {
            // Learning moved but the draft is still executable: offer, never swap it under the learner.
            const newer = rebuilt.adaptive !== undefined && adaptiveSuggestionsChanged(stored, rebuilt.adaptive);
            if (!newer || !options.refreshSuggestions) {
              return {
                draft: existing, skippedBecauseAccepted: false, dailyDraftSkippedReason: null,
                ...(newer ? { hasNewerSuggestion: true } : {}),
              };
            }
          }
          supersede = existing.id;
          prebuilt = rebuilt;
        }

        const built = prebuilt ?? await build();
        if (built.kind === "skip") {
          return {
            draft: null,
            skippedBecauseAccepted: false,
            dailyDraftSkippedReason: built.reason,
          };
        }

        const { input, adaptive } = built;
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
          unscheduledReasons: input.unscheduledReasons ?? [],
          algo: autoDraftAlgo(built),
          ...(adaptive ? {
            plannerInputRevision: adaptive.plannerInputRevision,
            suggestionKeys: adaptive.suggestedTasks.map((task) => task.key),
            ...(adaptive.courseMaterialRevisions ? { courseMaterialRevisions: adaptive.courseMaterialRevisions } : {}),
          } : {}),
          ...(built.fallbackReason ? { adaptiveFallback: built.fallbackReason } : {}),
        };
        if (supersede) {
          await tx`
            UPDATE opening_plan_drafts
            SET status = 'rejected',
                input_snapshot = input_snapshot || ${tx.json({ supersededBy: id, supersededReason: "auto_recompute" } as never)},
                updated_at = now()
            WHERE id = ${supersede} AND workspace_id = ${scope.workspaceId}
              AND owner_user_id = ${scope.ownerUserId} AND status = 'draft'`;
        }
        const rows = await tx`
          INSERT INTO opening_plan_drafts (
            id, workspace_id, owner_user_id, day, version, base_version, status,
            blocks, unscheduled_task_ids, input_snapshot, hard_blocks_fingerprint, propose_client_key,
            origin, suggested_tasks, reasons, strategy_version
          ) VALUES (
            ${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${day}::date, ${0}, ${baseVersion},
            ${"draft"}, ${tx.json(input.blocks as never)}, ${tx.json(input.unscheduledTaskIds as never)},
            ${tx.json(snapshot as never)}, ${fp}, ${clientKey},
            ${adaptive ? "auto_draft" : "user"}, ${tx.json((adaptive?.suggestedTasks ?? []) as never)},
            ${tx.json((adaptive?.reasons ?? {}) as never)}, ${adaptive?.strategyVersion ?? null}
          ) RETURNING *`;
        const draft = mapOpeningPlanDraft(rows[0] as Record<string, unknown>);
        await recordOpeningPlanDraftDecision(tx, scope, draft, input.unscheduledReasons);
        return {
          draft,
          skippedBecauseAccepted: false,
          dailyDraftSkippedReason: null,
        };
      });
    },
  };
}

/** Marker stored in auto-draft input_snapshot; drafts without it predate the PR-B local-day fix. */
const AUTO_DRAFT_ALGO = "local-day-v1";

/**
 * True when the stored unconfirmed auto draft was built by the current algorithm from
 * the same inputs (tasks + free/hard blocks). Time passing alone never triggers a
 * recompute, so a draft the user is looking at is not superseded under them.
 */
/** Key-order-insensitive JSON (jsonb does not preserve object key order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
    }
    return v;
  });
}

/** Adaptive drafts carry their strategy so turning the switch on or off rebuilds the open draft. */
function autoDraftAlgo(built: Extract<AutoDraftBuild, { kind: "propose" }>): string {
  return built.adaptive ? `${AUTO_DRAFT_ALGO}+${built.adaptive.strategyVersion}` : AUTO_DRAFT_ALGO;
}

function autoDraftInputsUnchanged(existingSnapshot: unknown, built: Extract<AutoDraftBuild, { kind: "propose" }>): boolean {
  if (!existingSnapshot || typeof existingSnapshot !== "object") return false;
  const snap = existingSnapshot as Record<string, unknown>;
  return snap.algo === autoDraftAlgo(built)
    && canonicalJson(snap.tasks) === canonicalJson(JSON.parse(JSON.stringify(built.input.tasks)))
    && canonicalJson(snap.free) === canonicalJson(JSON.parse(JSON.stringify(built.input.free)));
}

/** The learner's evidence or the suggestion set moved since the open draft was built. */
function adaptiveSuggestionsChanged(existingSnapshot: unknown, adaptive: AdaptiveDraftInput): boolean {
  const snap = existingSnapshot as Record<string, unknown>;
  return snap.plannerInputRevision !== adaptive.plannerInputRevision
    || canonicalJson(snap.suggestionKeys) !== canonicalJson(adaptive.suggestedTasks.map((task) => task.key));
}

export type OpeningPlansRepository = ReturnType<typeof createOpeningPlansRepository>;
