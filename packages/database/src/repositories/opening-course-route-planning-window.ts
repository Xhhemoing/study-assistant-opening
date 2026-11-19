import { openingPlanningSettingsSchema, type Scope } from "@aistudy/contracts";
import { isInstantOnLocalDay, resolveWorkspaceTimeZone } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { OpeningPlanError } from "./opening-plan-error";
import { courseRouteDelayedProtocolSchema } from "./opening-course-route-retest-state";

type CourseRouteDelayedProtocol = ReturnType<typeof courseRouteDelayedProtocolSchema.parse>;
type ParsedInstant = { iso: string; ms: number };

export type CourseRoutePlanningWindowProjection = {
  /** True only when the row is a verified owned course-route-delayed-v1 retest. */
  isCourseRouteRetest: boolean;
  /** True when the row has any linked opening_retest_activities record. */
  hasRetestActivity: boolean;
  /** Linked retest activity status, when present. */
  retestStatus: string | null;
  /** True when no retest is linked or the linked retest is still active ('accepted' | 'in_progress'). */
  retestActive: boolean;
  /** True only when a legacy task.due_at === 72h earliest-start miswrite is proven via immutable receipt + protocol. */
  legacyMiswrittenDueAt: boolean;
  /** Projected hard completion deadline (`dueAt`). */
  dueAt: string | null;
  /** Projected planning start floor (`notBefore`). */
  notBefore: string | null;
  /** Preserved retest recommendedAt (separate from scheduledStartAt). */
  recommendedAt: string | null;
  /** Preserved retest explicit reservation start time (separate from recommendedAt). */
  scheduledStartAt: string | null;
  /** Retest hard deadlineAt from opening_retest_activities.deadline_at. */
  deadlineAt: string | null;
};

export type LockedTaskPlanningWindow = {
  id: string;
  version: number;
  status: string;
  minutes: number;
  window: CourseRoutePlanningWindowProjection;
};

const ACTIVE_RETEST_STATUSES = new Set(["accepted", "in_progress"]);

function parseInstant(value: unknown): ParsedInstant | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? { iso: value.toISOString(), ms } : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : null;
  }
  return null;
}

function sameId(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string"
    && left.length > 0 && left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Proves a historical miswrite where pre-fix `opening-course-route-retest.ts` copied
 * the 72h earliest-start timestamp into `opening_tasks.due_at`.
 *
 * Never infers a miswrite from mutable `task.not_before === task.due_at` alone:
 * requires full agreement across task identity, `course-route-delayed-v1` retest
 * activity timestamps, and the immutable `opening_jobs` candidate acceptance receipt.
 */
function isProvenLegacyMiswrittenDueAt(
  row: Record<string, unknown>,
  protocol: CourseRouteDelayedProtocol,
  taskDueAt: ParsedInstant | null,
  retestNotBeforeAt: ParsedInstant | null,
  recommendedAt: ParsedInstant | null,
  deadlineAt: ParsedInstant | null,
): boolean {
  if (!taskDueAt || !deadlineAt || !retestNotBeforeAt || !recommendedAt) return false;
  if (taskDueAt.ms !== retestNotBeforeAt.ms || taskDueAt.ms !== recommendedAt.ms) return false;
  if (row.origin !== "retest") return false;
  if (!sameId(row.candidate_id, row.retest_candidate_id)) return false;
  if (!sameId(row.retest_candidate_id, row.retest_candidate_reference_id)) return false;
  if (!sameId(row.retest_candidate_id, row.retest_job_id)) return false;
  if (!sameId(row.workspace_id, row.retest_job_workspace_id)) return false;
  if (!sameId(row.owner_user_id, row.retest_job_owner_user_id)) return false;
  if (row.retest_job_kind !== "retest") return false;
  const acceptClientKey = typeof row.retest_accept_client_key === "string" ? row.retest_accept_client_key : "";
  if (!acceptClientKey) return false;

  const payload = row.retest_job_payload;
  const result = row.retest_job_result;
  if (!isRecord(payload) || !isRecord(result)) return false;
  const snapshot = result.inputSnapshot;
  if (!isRecord(snapshot)) return false;

  if (payload.accepted !== true || payload.kind !== "task") return false;
  if (!sameId(payload.id, row.retest_candidate_id)) return false;
  if (!sameId(payload.taskId, row.id)) return false;
  if (!sameId(payload.courseId, row.course_id)) return false;
  if (payload.acceptClientKey !== acceptClientKey) return false;
  if (parseInstant(payload.dueAt)?.ms !== taskDueAt.ms) return false;
  if (typeof payload.acceptPayloadHash !== "string" || payload.acceptPayloadHash.length === 0) return false;
  if (!Array.isArray(payload.evidenceObservationIds)
    || !payload.evidenceObservationIds.some((item) => sameId(item, protocol.baselineObservationId))) return false;
  if (!Array.isArray(payload.evidenceRootIds)
    || !payload.evidenceRootIds.some((item) => sameId(item, protocol.baselineRootId))) return false;

  if (result.accepted !== true) return false;
  if (!sameId(result.taskId, row.id)) return false;
  if (result.clientKey !== acceptClientKey) return false;
  if (result.payloadHash !== payload.acceptPayloadHash) return false;
  if (snapshot.kind !== "retest" || snapshot.heuristic !== true) return false;
  if (!sameId(snapshot.candidateId, row.retest_candidate_id)) return false;
  if (!sameId(snapshot.courseId, row.course_id)) return false;
  if (parseInstant(snapshot.dueAt)?.ms !== taskDueAt.ms) return false;

  return true;
}

/**
 * Shared planning-window projection for `listTasks`, ordinary plan accept, and local replan validation.
 * Ordinary tasks and non-course-route retests retain their existing `dueAt` / `notBefore` semantics.
 */
export function projectCourseRoutePlanningWindow(
  row: Record<string, unknown>,
  scope?: Scope,
): CourseRoutePlanningWindowProjection {
  const taskDueAt = parseInstant(row.due_at);
  const taskNotBefore = parseInstant(row.not_before);
  const activityId = typeof row.retest_activity_id === "string" && row.retest_activity_id.length > 0
    ? row.retest_activity_id
    : null;

  if (!activityId) {
    return {
      isCourseRouteRetest: false,
      hasRetestActivity: false,
      retestStatus: null,
      retestActive: true,
      legacyMiswrittenDueAt: false,
      dueAt: taskDueAt?.iso ?? null,
      notBefore: taskNotBefore?.iso ?? null,
      recommendedAt: null,
      scheduledStartAt: null,
      deadlineAt: null,
    };
  }

  const retestStatus = typeof row.retest_status === "string" ? row.retest_status : null;
  const retestActive = retestStatus === null ? true : ACTIVE_RETEST_STATUSES.has(retestStatus);
  const recommendedAt = parseInstant(row.retest_recommended_at);
  const scheduledStartAt = parseInstant(row.retest_scheduled_start_at);
  const retestNotBeforeAt = parseInstant(row.retest_not_before_at);
  const snoozedUntil = parseInstant(row.retest_snoozed_until);
  const deadlineAt = parseInstant(row.retest_deadline_at);

  const parsedProtocol = courseRouteDelayedProtocolSchema.safeParse(row.retest_learning_protocol);
  const scopeMatches = scope === undefined || (
    sameId(row.workspace_id, scope.workspaceId)
    && sameId(row.owner_user_id, scope.ownerUserId)
    && sameId(row.retest_workspace_id, scope.workspaceId)
    && sameId(row.retest_owner_user_id, scope.ownerUserId)
  );
  const isCourseRouteRetest = parsedProtocol.success
    && scopeMatches
    && sameId(row.workspace_id, row.retest_workspace_id)
    && sameId(row.owner_user_id, row.retest_owner_user_id)
    && sameId(row.id, row.retest_task_id)
    && sameId(row.course_id, row.retest_course_id)
    && (row.retest_purpose === undefined || row.retest_purpose === "retest");

  if (!isCourseRouteRetest) {
    return {
      isCourseRouteRetest: false,
      hasRetestActivity: true,
      retestStatus,
      retestActive,
      legacyMiswrittenDueAt: false,
      dueAt: taskDueAt?.iso ?? null,
      notBefore: taskNotBefore?.iso ?? null,
      recommendedAt: recommendedAt?.iso ?? null,
      scheduledStartAt: scheduledStartAt?.iso ?? null,
      deadlineAt: deadlineAt?.iso ?? null,
    };
  }

  const legacyMiswrittenDueAt = isProvenLegacyMiswrittenDueAt(
    row,
    parsedProtocol.data,
    taskDueAt,
    retestNotBeforeAt,
    recommendedAt,
    deadlineAt,
  );

  let effectiveDueAt: ParsedInstant | null;
  if (legacyMiswrittenDueAt) {
    effectiveDueAt = deadlineAt;
  } else if (taskDueAt && deadlineAt) {
    effectiveDueAt = taskDueAt.ms <= deadlineAt.ms ? taskDueAt : deadlineAt;
  } else {
    effectiveDueAt = taskDueAt ?? deadlineAt;
  }

  // Keep notBefore as the true earliest-start / deferral floor (never project explicit
  // scheduledStartAt into notBefore, which would make local-replan treat a valid same-day
  // future reservation as a deferred task). `effectivePlanningStartFloorMs` and
  // `taskNotBeforeAt` combine `notBefore` with `scheduledStartAt ?? recommendedAt`.
  const floorCandidates = [taskNotBefore, retestNotBeforeAt, snoozedUntil].filter(
    (value): value is ParsedInstant => value !== null,
  );
  const effectiveNotBefore = floorCandidates.length
    ? floorCandidates.reduce((latest, value) => (value.ms > latest.ms ? value : latest))
    : null;

  return {
    isCourseRouteRetest: true,
    hasRetestActivity: true,
    retestStatus,
    retestActive,
    legacyMiswrittenDueAt,
    dueAt: effectiveDueAt?.iso ?? null,
    notBefore: effectiveNotBefore?.iso ?? null,
    recommendedAt: recommendedAt?.iso ?? null,
    scheduledStartAt: scheduledStartAt?.iso ?? null,
    deadlineAt: deadlineAt?.iso ?? null,
  };
}

/**
 * Effective earliest start floor in epoch milliseconds for plan acceptance checks,
 * aligned with `retest-activity.ts` (`scheduledStartAt ?? recommendedAt` + `notBefore`).
 */
export function effectivePlanningStartFloorMs(window: CourseRoutePlanningWindowProjection): number | null {
  const candidates = [
    window.notBefore,
    window.scheduledStartAt ?? window.recommendedAt,
  ]
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Reads the workspace planning timeZone inside an active plan acceptance/validation transaction.
 */
export async function readWorkspacePlanningTimeZone(
  tx: TransactionSql,
  scope: Scope,
): Promise<string> {
  const [preferences] = await tx`SELECT planning_settings FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  const stored = preferences?.planning_settings;
  if (stored == null) return resolveWorkspaceTimeZone(undefined);
  const parsed = openingPlanningSettingsSchema.safeParse(stored);
  if (!parsed.success) {
    throw new OpeningPlanError("CONFLICT", "planning constraints changed; refresh", "stale_version");
  }
  return resolveWorkspaceTimeZone(parsed.data.timeZone);
}

/**
 * Explicit retest reservations (`scheduledStartAt`) are pinned to their local calendar
 * day in the workspace timeZone; neither earlier nor later days may schedule or confirm them.
 */
export function isScheduledStartAllowedOnDay(
  scheduledStartAt: string | null,
  day: string,
  timeZone: string,
): boolean {
  if (!scheduledStartAt) return true;
  try {
    return isInstantOnLocalDay(scheduledStartAt, day, timeZone);
  } catch {
    return false;
  }
}

/**
 * Validates that a planned block satisfies a task's current planning window:
 * same-day explicit reservation (in workspace timeZone), start floor, and real hard deadline.
 */
export function isBlockAllowedForTaskWindow(
  block: { start: string; end: string },
  window: CourseRoutePlanningWindowProjection,
  day: string,
  timeZone: string,
): boolean {
  if (!isScheduledStartAllowedOnDay(window.scheduledStartAt, day, timeZone)) return false;
  const startMs = Date.parse(block.start);
  const endMs = Date.parse(block.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return false;
  const earliestStartMs = effectivePlanningStartFloorMs(window);
  if (earliestStartMs !== null && startMs < earliestStartMs) return false;
  const dueMs = window.dueAt ? Date.parse(window.dueAt) : null;
  if (dueMs !== null && endMs > dueMs) return false;
  return true;
}

/**
 * Transactional re-read used by ordinary plan confirmation and local replan validation.
 * Callers already hold `lockWorkspaceLearningHistory(tx, scope)`; `FOR UPDATE OF t`
 * locks the task rows without triggering PostgreSQL's outer-join locking error.
 */
export async function readLockedTaskPlanningWindows(
  tx: TransactionSql,
  scope: Scope,
  taskIds: readonly string[],
): Promise<LockedTaskPlanningWindow[]> {
  if (!taskIds.length) return [];
  const ids = [...new Set(taskIds)];
  const rows = await tx`
    SELECT
      t.id,
      t.workspace_id,
      t.owner_user_id,
      t.version,
      t.status,
      t.minutes,
      t.due_at,
      t.not_before,
      t.course_id,
      t.candidate_id,
      t.origin,
      a.id AS retest_activity_id,
      a.workspace_id AS retest_workspace_id,
      a.owner_user_id AS retest_owner_user_id,
      a.task_id AS retest_task_id,
      a.course_id AS retest_course_id,
      a.purpose AS retest_purpose,
      a.status AS retest_status,
      a.candidate_id AS retest_candidate_id,
      a.candidate_reference_id AS retest_candidate_reference_id,
      a.accept_client_key AS retest_accept_client_key,
      a.learning_protocol AS retest_learning_protocol,
      a.not_before_at AS retest_not_before_at,
      a.recommended_at AS retest_recommended_at,
      a.scheduled_start_at AS retest_scheduled_start_at,
      a.snoozed_until AS retest_snoozed_until,
      a.deadline_at AS retest_deadline_at,
      j.id AS retest_job_id,
      j.workspace_id AS retest_job_workspace_id,
      j.owner_user_id AS retest_job_owner_user_id,
      j.kind AS retest_job_kind,
      j.payload AS retest_job_payload,
      j.result AS retest_job_result
    FROM opening_tasks t
    LEFT JOIN opening_retest_activities a
      ON a.task_id = t.id
      AND a.workspace_id = t.workspace_id
      AND a.owner_user_id = t.owner_user_id
    LEFT JOIN opening_jobs j
      ON j.id = a.candidate_id
      AND j.workspace_id = t.workspace_id
      AND j.owner_user_id = t.owner_user_id
      AND j.kind = 'retest'
    WHERE t.workspace_id = ${scope.workspaceId}
      AND t.owner_user_id = ${scope.ownerUserId}
      AND t.id IN ${tx(ids)}
    ORDER BY t.id
    FOR UPDATE OF t`;
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id),
      version: Number(record.version),
      status: String(record.status),
      minutes: Number(record.minutes),
      window: projectCourseRoutePlanningWindow(record, scope),
    };
  });
}
