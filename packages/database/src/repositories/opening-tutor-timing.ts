import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";

export type OpeningTutorTimingInput = {
  jobId: string;
  executionId: string;
  claimToken: string;
  kind: "tutor_first_text" | "tutor_first_chunk";
  observedAt: Date | string;
  durationMs?: number;
};

/** Timing is descriptive: only a current lease may extend its own claimed execution. */
export async function recordOpeningTutorTiming(sql: Sql, scope: Scope, input: OpeningTutorTimingInput): Promise<{ recorded: boolean }> {
  const observedAt = input.observedAt instanceof Date ? new Date(input.observedAt.getTime()) : new Date(input.observedAt);
  if (!Number.isFinite(observedAt.getTime()) || input.durationMs !== undefined
    && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 2_147_483_647)) throw new Error("invalid tutor timing");
  return sql.begin(async tx => {
  // Telemetry may not hold up the business transaction. These transaction-local
  // PG16-compatible limits cover lock waits, active statements and a stalled
  // client between statements; they never change claim/complete session policy.
  await tx`SELECT set_config('lock_timeout', '50ms', true),
    set_config('statement_timeout', '100ms', true),
    set_config('idle_in_transaction_session_timeout', '100ms', true)`;
  const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR KEY SHARE`;
  if (!owner.length) return { recorded: false };
  const rows = await tx`WITH current_execution AS (
    SELECT j.id, claimed.local_day FROM opening_tutor_jobs j
    JOIN workspaces w ON w.id=j.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    JOIN opening_learning_experience_events claimed ON claimed.workspace_id=j.workspace_id
      AND claimed.owner_user_id=w.owner_user_id AND claimed.target_type='job' AND claimed.target_id=j.id
      AND claimed.kind='tutor_claimed' AND claimed.execution_id=${input.executionId}::uuid
      AND claimed.event_key=${`tutor_claimed:${input.jobId}:${input.executionId}`}
    WHERE j.id=${input.jobId}::uuid AND j.workspace_id=${scope.workspaceId}::uuid
      AND j.status='running' AND j.claim_token=${input.claimToken}::uuid AND j.timing_execution_id=${input.executionId}::uuid
    FOR SHARE OF j
  ) INSERT INTO opening_learning_experience_events
      (workspace_id,owner_user_id,event_key,kind,target_type,target_id,local_day,duration_ms,execution_id,observed_at,recorded_at)
    SELECT ${scope.workspaceId},${scope.ownerUserId},${`${input.kind}:${input.jobId}:${input.executionId}`},${input.kind},'job',id,
      local_day,${input.durationMs ?? null},${input.executionId}::uuid,${observedAt},clock_timestamp()
    FROM current_execution ON CONFLICT(workspace_id,owner_user_id,event_key) DO NOTHING RETURNING id`;
  return { recorded: rows.length > 0 };
  });
}
