import "server-only";
import type { Sql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { lockWorkspaceLearningHistory, requireActiveCaptureCourse } from "@aistudy/database";
import { resolveWorkspaceTimeZone } from "@aistudy/domain";
import { ApiError } from "../../auth/service";

type RetellInput = { sourceId: string; title: string; courseId?: string | null; timeZone?: string };

export async function finishCapture(sql: Sql, scope: Scope, input: RetellInput & { scheduleNextDayRetell: boolean }) {
  if (!input.courseId && !input.scheduleNextDayRetell) return null;
  return sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, scope);
    const courseId = input.courseId ?? null;
    const [source] = await tx`SELECT s.id, EXISTS (
      SELECT 1 FROM course_asset_memberships m WHERE m.workspace_id=s.workspace_id
        AND m.course_id=${courseId} AND m.asset_type='source' AND m.asset_id=s.id
    ) AS linked FROM opening_sources s
      WHERE s.id = ${input.sourceId} AND s.workspace_id = ${scope.workspaceId} AND s.upload_state = 'uploaded'
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.source_id = s.id) FOR SHARE`;
    if (!source) throw new ApiError("CONFLICT", "讲解资料已不可用。", 409);
    const [existing] = input.scheduleNextDayRetell
      ? await tx`SELECT id, client_key, origin, course_id, not_before, created_at FROM opening_tasks
          WHERE id = ${input.sourceId} AND workspace_id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId}`
      : [];
    if (courseId && (!source.linked || (input.scheduleNextDayRetell && !existing))) {
      await requireActiveCaptureCourse(tx, scope, courseId);
    }
    if (courseId && !source.linked) {
      await tx`INSERT INTO course_asset_memberships (workspace_id, course_id, asset_type, asset_id, role, visibility, purpose)
        VALUES (${scope.workspaceId}, ${courseId}, 'source', ${input.sourceId}, 'reference', 'private', 'reference')
        ON CONFLICT (course_id, asset_type, asset_id) DO NOTHING`;
    }
    if (!input.scheduleNextDayRetell) return null;
    // One agent-scheduled retell task per source. The original deferral decision
    // survives task edits, retest completion and retries on subsequent calendar days.
    const key = `text-retell:${input.sourceId}`;
    const deferredKey = key + ":deferred";
    if (existing) {
      if (existing.origin !== "agent" || ![key, deferredKey].includes(existing.client_key) || existing.course_id !== courseId) {
        throw new ApiError("CONFLICT", "这次保存已关联其他任务。", 409);
      }
      if (existing.client_key !== deferredKey) {
        return {
          taskId: input.sourceId,
          notBefore: existing.not_before as Date | null,
          deferredBehindActiveRetest: false,
          replayed: true,
        };
      }
      const createdAt = existing.created_at instanceof Date || typeof existing.created_at === "string"
        ? existing.created_at
        : new Date(0);
      const [hold] = await tx<{ open_ended: boolean | null; end_at: Date | null }[]>`SELECT
        bool_or(r.status IN ('proposed', 'accepted', 'in_progress')
          AND (r.deadline_at IS NULL OR r.deadline_at <= statement_timestamp())) AS open_ended,
        max(CASE
          WHEN r.status IN ('proposed', 'accepted', 'in_progress') THEN r.deadline_at
          ELSE COALESCE(r.completed_at, r.declined_at, r.cancelled_at, r.invalidated_at, r.superseded_at, r.updated_at)
        END) AS end_at
        FROM opening_retest_activities r
        WHERE r.workspace_id = ${scope.workspaceId} AND r.owner_user_id = ${scope.ownerUserId}
          AND (${courseId}::uuid IS NULL OR r.course_id = ${courseId})
          AND (
            r.status IN ('proposed', 'accepted', 'in_progress')
            OR COALESCE(r.completed_at, r.declined_at, r.cancelled_at, r.invalidated_at, r.superseded_at, r.updated_at) >= ${createdAt}
          )`;
      const baseFloorMs = existing.not_before ? new Date(existing.not_before as string | Date).getTime() : 0;
      const endFloorMs = hold?.end_at ? new Date(hold.end_at).getTime() + 1000 : 0;
      const resolvedNotBefore = hold?.open_ended
        ? null
        : new Date(Math.max(baseFloorMs, endFloorMs));
      return {
        taskId: input.sourceId,
        notBefore: resolvedNotBefore,
        deferredBehindActiveRetest: true,
        replayed: true,
      };
    }

    const [preferences] = input.timeZone ? [] : await tx`SELECT planning_settings->>'timeZone' AS zone
      FROM workspace_preferences WHERE workspace_id = ${scope.workspaceId}`;
    const zone = resolveWorkspaceTimeZone(input.timeZone ?? preferences?.zone);
    // Only a future hard retest deadline counts as a reliable end time; open-ended
    // or overdue active retests keep the retell held until the retest closes.
    const [window] = await tx<{
      tomorrow: Date;
      active: boolean;
      open_ended: boolean | null;
      last_deadline_at: Date | null;
    }[]>`SELECT
      ((statement_timestamp() AT TIME ZONE ${zone})::date + 1)::timestamp AT TIME ZONE ${zone} AS tomorrow,
      count(*) > 0 AS active,
      bool_or(r.deadline_at IS NULL OR r.deadline_at <= statement_timestamp()) AS open_ended,
      max(r.deadline_at) AS last_deadline_at
      FROM opening_retest_activities r
      WHERE r.workspace_id = ${scope.workspaceId} AND r.owner_user_id = ${scope.ownerUserId}
        AND (${courseId}::uuid IS NULL OR r.course_id = ${courseId})
        AND r.status IN ('proposed', 'accepted', 'in_progress')`;
    if (!window) throw new Error("Missing retell scheduling window");
    const storedNotBefore = window.active
      ? new Date(Math.max(window.tomorrow.getTime(), window.last_deadline_at ? window.last_deadline_at.getTime() + 1000 : 0))
      : window.tomorrow;
    const reportedNotBefore = window.active && Boolean(window.open_ended) ? null : storedNotBefore;
    const title = window.active ? "完成复测后，闭卷复述已保存讲解的关键步骤" : `闭卷复述《${input.title}》的关键步骤`;
    // Before retell keys were reserved, a learner-created task could hold either key.
    await tx`UPDATE opening_tasks SET client_key=NULL
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND client_key IN (${key}, ${deferredKey}) AND origin IN ('manual', 'course_seed')`;
    await tx`INSERT INTO opening_tasks (id, workspace_id, owner_user_id, course_id, title, minutes, origin, client_key, not_before)
      VALUES (${input.sourceId}, ${scope.workspaceId}, ${scope.ownerUserId}, ${courseId},
        ${title}, 10, ${"agent"}, ${window.active ? deferredKey : key}, ${storedNotBefore})`;
    return {
      taskId: input.sourceId,
      notBefore: reportedNotBefore,
      deferredBehindActiveRetest: window.active,
      replayed: false,
    };
  });
}
