import type { Sql } from "postgres";
import { learningExperienceInputSchema, type Scope } from "@aistudy/contracts";
import { localDateKeyInZone, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { OpeningPlanError } from "./opening-plan-error";

/** Client observations are descriptive metrics, never learning evidence or billing authority. */
export async function recordOpeningLearningExperience(sql: Sql, scope: Scope, raw: unknown, now = new Date()) {
  const input = learningExperienceInputSchema.parse(raw);
  return sql.begin(async tx => {
    const [owner] = await tx`SELECT p.planning_settings FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
      WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
    if (!owner) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
    const zone = (owner.planning_settings as { timeZone?: string } | null)?.timeZone;
    const day = localDateKeyInZone(now, resolveWorkspaceTimeZone(zone));
    const targetId = input.kind === "first_text" ? input.jobId : input.targetId;
    const targetType = input.kind === "first_text" ? "job" : input.targetType;
    let found = false;
    if (input.kind === "first_text") {
      const rows = await tx`SELECT j.id FROM opening_tutor_jobs j JOIN opening_turns u ON u.id=j.user_turn_id AND u.workspace_id=j.workspace_id
        JOIN opening_conversations c ON c.id=j.conversation_id AND c.workspace_id=j.workspace_id
        WHERE j.id=${targetId} AND j.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
          AND u.client_key=${input.clientKey} AND u.role='user'`;
      found = rows.length > 0;
    } else if (targetType === "course") {
      found = (await tx`SELECT id FROM courses WHERE id=${targetId} AND workspace_id=${scope.workspaceId} AND archived_at IS NULL`).length > 0;
    } else if (targetType === "activity") {
      found = (await tx`SELECT id FROM opening_teaching_activities WHERE id=${targetId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`).length > 0;
    } else {
      found = (await tx`SELECT id FROM opening_conversations WHERE id=${targetId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`).length > 0;
    }
    if (!found) throw new OpeningPlanError("NOT_FOUND", "measurement target not found");
    const suffix = `${targetType}:${targetId}:${day}`;
    if (input.kind === "next_step_started") {
      const shown = await tx`SELECT 1 FROM opening_learning_experience_events WHERE workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND event_key=${`next_step_shown:${suffix}`}`;
      if (!shown.length) return { recorded: false };
    }
    const key = input.kind === "first_text" ? `first_text:${targetId}` : `${input.kind}:${suffix}`;
    const rows = await tx`INSERT INTO opening_learning_experience_events(workspace_id,owner_user_id,event_key,kind,target_type,target_id,local_day,duration_ms,recorded_at)
      VALUES(${scope.workspaceId},${scope.ownerUserId},${key},${input.kind},${targetType},${targetId},${day},${input.kind === "first_text" ? input.durationMs : null},${now})
      ON CONFLICT(workspace_id,owner_user_id,event_key) DO NOTHING RETURNING id`;
    return { recorded: rows.length > 0 };
  });
}
