import type { Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";

/** Only untouched, task-free suggestions are refundable; published content alone is not an issued attempt. */
export async function readUnusedStaleCourseRouteReservations(db: Sql | TransactionSql, scope: Scope) {
  return db`SELECT a.id FROM opening_teaching_activities a
    JOIN opening_learning_observations o ON o.id::text=a.goal_json->'courseRoute'->>'originObservationId'
      AND o.workspace_id=a.workspace_id AND o.owner_user_id=a.owner_user_id
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}
      AND COALESCE(root.effective_head_id,root.id)<>o.id
      AND a.status IN ('active','paused','skipped') AND a.checkpoint_json='{}'::jsonb
      AND NOT (a.create_intent ? 'taskId')
      AND NOT (a.goal_json->'courseRoute' ? 'retestId')
      AND NOT EXISTS (SELECT 1 FROM opening_learning_attempts p WHERE p.activity_id=a.id
        AND p.workspace_id=a.workspace_id AND p.owner_user_id=a.owner_user_id)
      AND NOT EXISTS (SELECT 1 FROM opening_learning_observations p WHERE p.activity_id=a.id
        AND p.workspace_id=a.workspace_id AND p.owner_user_id=a.owner_user_id)
      AND NOT EXISTS (SELECT 1 FROM opening_help_exposures h WHERE h.workspace_id=a.workspace_id
        AND (h.activity_id=a.id OR h.session_id IN (SELECT s.id FROM opening_learning_sessions s
          WHERE s.activity_id=a.id AND s.workspace_id=a.workspace_id AND s.owner_user_id=a.owner_user_id))
        AND (h.delivered=true OR h.released_at IS NOT NULL))`;
}
