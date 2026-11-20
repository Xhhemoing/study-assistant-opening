import "server-only";
import type { Sql, TransactionSql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { lockWorkspaceLearningHistory } from "@aistudy/database";
import { resolveWorkspaceTimeZone } from "@aistudy/domain";
import { ApiError } from "../../auth/service";

export async function requireCaptureCourse(db: Sql | TransactionSql, scope: Scope, courseId?: string | null) {
  if (!courseId) return;
  const [course] = await db`SELECT id FROM courses WHERE id = ${courseId}
    AND workspace_id = ${scope.workspaceId} AND archived_at IS NULL FOR SHARE`;
  if (!course) throw new ApiError("NOT_FOUND", "找不到这门课程。", 404);
}

type RetellInput = { sourceId: string; title: string; courseId?: string | null; timeZone?: string };

export async function scheduleRetell(sql: Sql, scope: Scope, input: RetellInput) {
  return sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, scope);
    await requireCaptureCourse(tx, scope, input.courseId);
    const courseId = input.courseId ?? null;
    // One ordinary task per source. The original deferral decision survives
    // task edits, retest completion and retries on subsequent calendar days.
    const key = `text-retell:${input.sourceId}`;
    const deferredKey = key + ":deferred";
    const [existing] = await tx`SELECT id, client_key, course_id, not_before FROM opening_tasks
      WHERE id = ${input.sourceId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`;
    if (existing) {
      if (![key, deferredKey].includes(existing.client_key) || existing.course_id !== courseId) {
        throw new ApiError("CONFLICT", "这次保存已关联其他任务。", 409);
      }
      return { taskId: input.sourceId, notBefore: existing.not_before as Date | null,
        deferredBehindActiveRetest: existing.client_key === deferredKey, replayed: true };
    }

    const [source] = await tx`SELECT s.id FROM opening_sources s
      WHERE s.id = ${input.sourceId} AND s.workspace_id = ${scope.workspaceId} AND s.upload_state = 'uploaded'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.source_id = s.id) FOR SHARE`;
    if (!source) throw new ApiError("CONFLICT", "讲解资料已不可用。", 409);

    const [preferences] = input.timeZone ? [] : await tx`SELECT planning_settings->>'timeZone' AS zone
      FROM workspace_preferences WHERE workspace_id = ${scope.workspaceId}`;
    const zone = resolveWorkspaceTimeZone(input.timeZone ?? preferences?.zone);
    // PostgreSQL resolves local midnight even in zones with a clock change at midnight.
    const [window] = await tx<{ tomorrow: Date; active: boolean; last_at: Date | null }[]>`SELECT
      ((statement_timestamp() AT TIME ZONE ${zone})::date + 1)::timestamp AT TIME ZONE ${zone} AS tomorrow,
      count(*) > 0 AS active, max(greatest(r.not_before_at, r.recommended_at,
        r.scheduled_start_at, r.deadline_at, r.snoozed_until, t.not_before, t.due_at)) AS last_at
      FROM opening_retest_activities r
      LEFT JOIN opening_tasks t ON t.id = r.task_id AND t.workspace_id = r.workspace_id AND t.owner_user_id = r.owner_user_id
      WHERE r.workspace_id = ${scope.workspaceId} AND r.owner_user_id = ${scope.ownerUserId}
        AND (${courseId}::uuid IS NULL OR r.course_id = ${courseId})
        AND r.status IN ('proposed', 'accepted', 'in_progress')`;
    if (!window) throw new Error("Missing retell scheduling window");
    // One second also clears any sub-millisecond precision in the stored deadline.
    const notBefore = window.active
      ? new Date(Math.max(window.tomorrow.getTime(), window.last_at?.getTime() ?? 0) + 1000)
      : window.tomorrow;
    const title = window.active ? "完成复测后，闭卷复述已保存讲解的关键步骤" : `闭卷复述《${input.title}》的关键步骤`;
    await tx`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, course_id, title, minutes, client_key, not_before)
      VALUES (${input.sourceId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${courseId},
        ${title}, 10, ${window.active ? deferredKey : key}, ${notBefore})`;
    return { taskId: input.sourceId, notBefore, deferredBehindActiveRetest: window.active, replayed: false };
  });
}
