import type { Sql, TransactionSql } from "postgres";
import { assistantCandidateSchema, retestCandidateSchema } from "@aistudy/contracts";
import type { OpeningScope } from "./opening-sources";
import { createOpeningCandidateRepository } from "./opening-candidates";
import { lockLearningHistory } from "./opening-learning-facts";
import { OpeningPlanError } from "./opening-plan-error";
import { includedTurn } from "./opening-backup-record-predicates";
import { admitTaskCandidate } from "./opening-task-candidate-admission";

type Db = Sql | TransactionSql;
function cleanJsonSources(db: Db, scope: OpeningScope, ids: ReturnType<Db>) {
  return db`jsonb_typeof(${ids}) = 'array' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${ids}) = 'array' THEN ${ids} ELSE '[]'::jsonb END) ref(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM opening_sources s WHERE s.id::text = lower(ref.id)
        AND s.workspace_id = ${scope.workspaceId} AND s.upload_state = 'uploaded'
    ) OR EXISTS (
      SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id = ${scope.workspaceId} AND e.source_id::text = lower(ref.id)
    ))`;
}
function admittedRetest(db: Db, scope: OpeningScope) {
  return db`EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${scope.workspaceId} AND w.owner_user_id = ${scope.ownerUserId})
    AND EXISTS (SELECT 1 FROM courses c WHERE c.id::text = j.payload->>'courseId' AND c.workspace_id = ${scope.workspaceId})
    AND (j.payload->>'accepted' = 'true' OR COALESCE(j.payload->>'invalidated', 'false') = 'false')
    AND ${cleanJsonSources(db, scope, db`j.payload->'sourceIds'`)}`;
}
export async function readOpeningAssistantReviewCandidates(sql: Sql, scope: OpeningScope) {
  const candidates = await createOpeningCandidateRepository(sql).listPending(scope);
  const rows = await sql`
    SELECT a.id FROM opening_assistant_candidates a
    JOIN opening_turns t ON t.id = a.source_turn_id AND t.conversation_id = a.conversation_id
      AND t.workspace_id = a.workspace_id AND t.status = 'complete'
    WHERE a.workspace_id = ${scope.workspaceId} AND a.status = 'pending'
      AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ${scope.workspaceId} AND w.owner_user_id = ${scope.ownerUserId})
      AND ${cleanJsonSources(sql, scope, sql`a.source_ids`)}
      AND ${includedTurn(sql, scope.workspaceId, scope.ownerUserId, "t")}`;
  const visible = new Set(rows.map((row) => row.id as string));
  return candidates.filter((candidate) => visible.has(candidate.id) && assistantCandidateSchema.safeParse(candidate.payload).success);
}
export async function readOpeningRetestReviewCandidates(sql: Sql, scope: OpeningScope) {
  const rows = await sql`
    SELECT j.id, j.payload FROM opening_jobs j
    WHERE j.workspace_id = ${scope.workspaceId} AND j.owner_user_id = ${scope.ownerUserId}
      AND j.kind = 'retest' AND j.state = 'succeeded' AND j.payload->>'kind' = 'task'
      AND COALESCE(j.payload->>'accepted', 'false') = 'false'
      AND COALESCE(j.payload->>'discarded', 'false') = 'false' AND ${admittedRetest(sql, scope)}
    ORDER BY j.created_at, j.id`;
  return rows.flatMap((row) => {
    const parsed = retestCandidateSchema.safeParse(row.payload);
    return parsed.success && parsed.data.id === row.id && parsed.data.kind === "task" && !parsed.data.accepted
      ? [parsed.data] : [];
  });
}
/** Recheck current admission after acquiring the decision and evidence locks. */
export async function assertOpeningRetestReviewAccess(sql: Db, scope: OpeningScope, id: string): Promise<void> {
  const rows = await sql`
    SELECT j.id FROM opening_jobs j WHERE j.id = ${id} AND j.workspace_id = ${scope.workspaceId}
      AND j.owner_user_id = ${scope.ownerUserId} AND j.kind = 'retest' AND j.state = 'succeeded' AND j.payload->>'kind' = 'task'
      AND ${admittedRetest(sql, scope)}`;
  if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "retest candidate or its sources are unavailable");
}
/** Shared lock order with evidence correction: owner/privacy → course history → job. */
export async function lockOpeningRetestReviewCandidate(tx: TransactionSql, scope: OpeningScope, id: string) {
  const owners = await tx`SELECT id FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
  if (!owners.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
  const preview = await tx`SELECT c.id AS course_id FROM opening_jobs j JOIN courses c ON c.id::text=j.payload->>'courseId' AND c.workspace_id=j.workspace_id
    WHERE j.id=${id} AND j.workspace_id=${scope.workspaceId} AND j.owner_user_id=${scope.ownerUserId} AND j.kind='retest'`;
  if (!preview[0]) throw new OpeningPlanError("NOT_FOUND", "retest candidate course not found");
  await lockLearningHistory(tx, scope, String(preview[0].course_id));
  const rows = await tx`
    SELECT payload FROM opening_jobs WHERE id = ${id} AND workspace_id = ${scope.workspaceId}
      AND owner_user_id = ${scope.ownerUserId} AND kind = 'retest' FOR UPDATE`;
  if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "retest candidate not found");
  const payload = rows[0]!.payload as { kind?: string; courseId?: string; accepted?: boolean; discarded?: boolean; invalidated?: boolean };
  if (payload?.courseId !== preview[0].course_id) throw new OpeningPlanError("CONFLICT", "retest candidate attribution changed");
  if (payload?.kind !== "task") throw new OpeningPlanError("VALIDATION", "retest candidate payload.kind must be task");
  await tx`
    SELECT c.id FROM courses c JOIN opening_jobs j ON c.id::text = j.payload->>'courseId'
    WHERE j.id = ${id} AND c.workspace_id = ${scope.workspaceId} FOR SHARE OF c`;
  await tx`
    SELECT s.id FROM opening_sources s WHERE s.workspace_id = ${scope.workspaceId} AND s.id::text IN (
      SELECT lower(ref.id) FROM opening_jobs j CROSS JOIN LATERAL
        jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.payload->'sourceIds') = 'array' THEN j.payload->'sourceIds' ELSE '[]'::jsonb END) ref(id)
      WHERE j.id = ${id}
    ) ORDER BY s.id FOR SHARE`;
  await assertOpeningRetestReviewAccess(tx, scope, id);
  return payload;
}
export async function discardOpeningAssistantTask(sql: Sql, scope: OpeningScope, id: string) {
  return sql.begin(async (tx) => {
    await admitTaskCandidate(tx, scope, id);
    const rows = await tx`SELECT status FROM opening_assistant_candidates WHERE id = ${id} AND workspace_id = ${scope.workspaceId} FOR UPDATE`;
    if (rows[0]?.status === "accepted") throw new OpeningPlanError("CONFLICT", "task candidate already accepted");
    if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "task candidate unavailable");
    if (rows[0]!.status === "pending") {
      await tx`UPDATE opening_assistant_candidates SET status = 'discarded', updated_at = now() WHERE id = ${id}`;
    }
    return { id, status: "discarded" as const };
  });
}
export async function discardOpeningRetest(sql: Sql, scope: OpeningScope, id: string, clientKey: string) {
  return sql.begin(async (tx) => {
    const payload = await lockOpeningRetestReviewCandidate(tx, scope, id);
    if (payload.accepted) throw new OpeningPlanError("CONFLICT", "retest candidate already accepted");
    if (!payload.discarded) await tx`UPDATE opening_jobs SET payload = payload || ${tx.json({ discarded: true, discardClientKey: clientKey })}, updated_at = now() WHERE id = ${id}`;
    return { id, status: "discarded" as const };
  });
}
