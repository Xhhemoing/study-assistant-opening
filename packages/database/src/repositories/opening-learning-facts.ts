import type { Sql, TransactionSql } from "postgres";
import type { LearningObservation, Scope } from "@aistudy/contracts";
export type LearningSql = Sql | TransactionSql;
export function learningError(code: "NOT_FOUND" | "VALIDATION" | "CONFLICT", message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
export const learningIso = (value: unknown): string | null => value == null ? null : new Date(value as string | Date).toISOString();
/** Lock before any owner/course/root/activity/task lock; readers never lock this row. */
export async function lockWorkspaceLearningHistory(tx: TransactionSql, scope: Scope): Promise<void> {
  const owners = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!owners.length) throw learningError("NOT_FOUND", "workspace not found");
  await tx`INSERT INTO opening_workspace_history_revisions(workspace_id,owner_user_id,revision)
    VALUES (${scope.workspaceId},${scope.ownerUserId},0) ON CONFLICT DO NOTHING`;
  await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
}
/** Advance once for a real learning-semantic mutation, in the transaction holding the counter lock. Non-observation mutations leave valid gaps in fixed-R history. */
export async function nextWorkspaceLearningHistoryRevision(tx: TransactionSql, scope: Scope): Promise<number> {
  const [row] = await tx`UPDATE opening_workspace_history_revisions SET revision=revision+1
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} RETURNING revision`;
  if (!row) throw learningError("CONFLICT", "workspace history counter missing");
  return Number(row.revision);
}
export async function lockLearningOwner(tx: TransactionSql, scope: Scope): Promise<void> {
  const rows = await tx`SELECT id FROM workspaces WHERE id = ${scope.workspaceId} AND owner_user_id = ${scope.ownerUserId} FOR SHARE`;
  if (!rows.length) throw learningError("NOT_FOUND", "workspace not found");
}
export async function lockLearningSession(tx: TransactionSql, scope: Scope, sessionId: string) {
  await lockLearningOwner(tx, scope);
  const rows = await tx`SELECT l.* FROM opening_learning_sessions l JOIN courses c ON c.id = l.course_id AND c.workspace_id = l.workspace_id
    WHERE l.id = ${sessionId} AND l.workspace_id = ${scope.workspaceId} AND l.owner_user_id = ${scope.ownerUserId}
      AND c.archived_at IS NULL FOR SHARE OF l, c`;
  if (!rows.length) throw learningError("NOT_FOUND", "learning session or course not found");
  return rows[0]!;
}
export async function lockLearningHistory(tx: TransactionSql, scope: Scope, courseId: string): Promise<void> {
  await tx`INSERT INTO opening_learning_history_revisions(workspace_id,owner_user_id,course_id,revision)
    VALUES (${scope.workspaceId},${scope.ownerUserId},${courseId},0) ON CONFLICT DO NOTHING`;
  await tx`SELECT revision FROM opening_learning_history_revisions WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} FOR UPDATE`;
}
/** Allocated only inside the fact transaction. Rollback does not advance the committed watermark. */
export async function nextLearningHistoryRevision(tx: TransactionSql, scope: Scope, courseId: string): Promise<number> {
  const rows = await tx`INSERT INTO opening_learning_history_revisions(workspace_id,owner_user_id,course_id,revision)
    VALUES (${scope.workspaceId},${scope.ownerUserId},${courseId},1)
    ON CONFLICT (workspace_id,owner_user_id,course_id) DO UPDATE SET revision = opening_learning_history_revisions.revision + 1 RETURNING revision`;
  return Number(rows[0]!.revision);
}
export async function admitLearningSources(tx: TransactionSql, scope: Scope, sourceIds: readonly string[]) {
  const ids = [...new Set(sourceIds)].sort();
  if (!ids.length) return [];
  const rows = await tx`SELECT s.id,s.version,s.bytes,s.sha256 FROM opening_sources s
    WHERE s.workspace_id = ${scope.workspaceId} AND s.id IN ${tx(ids)} AND s.upload_state = 'uploaded'
      AND EXISTS (SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=s.version)
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=s.id)
    ORDER BY s.id FOR SHARE`;
  if (rows.length !== ids.length) throw learningError("VALIDATION", "source unavailable or privacy-excluded");
  for (const row of rows) await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES (${row.id},${row.version},${scope.workspaceId},${row.bytes},${row.sha256},'available') ON CONFLICT(source_id,version) DO NOTHING`;
  return rows;
}
export function mapLearningObservation(row: Record<string, unknown>): LearningObservation {
  return {
    rootObservationId: String(row.root_observation_id ?? row.id),
    revisesObservationId: (row.revises_observation_id ?? null) as string | null,
    revisionKind: (row.revision_kind ?? "original") as LearningObservation["revisionKind"],
    revisionReason: (row.revision_reason ?? null) as string | null, actorId: (row.actor_id ?? null) as string | null,
    effectiveHeadId: (row.effective_head_id ?? (row.root_observation_id == null ? row.id : null)) as string | null,
    id: String(row.id), workspaceId: String(row.workspace_id), sessionId: String(row.session_id), courseId: String(row.course_id),
    skillLabel: String(row.skill_label), sourceIds: (row.source_ids ?? []) as string[], problemId: row.problem_id as string | null,
    retestId: row.retest_id as string | null, answer: String(row.answer), outcome: row.outcome as LearningObservation["outcome"],
    assistance: row.assistance as LearningObservation["assistance"], clientKey: String(row.client_key), occurredAt: learningIso(row.occurred_at)!,
    sourceTurnIds: (row.source_turn_ids ?? []) as string[], verdictSource: row.verdict_source as LearningObservation["verdictSource"],
    referenceSourceId: row.reference_source_id as string | null, evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    attemptId: (row.attempt_id ?? null) as string | null, itemVersionId: (row.item_version_id ?? null) as string | null,
    requirementKey: (row.requirement_key ?? null) as string | null, startedAt: learningIso(row.started_at), submittedAt: learningIso(row.submitted_at),
    recordedAt: learningIso(row.recorded_at), sourceVersions: (row.source_versions ?? null) as Record<string, number> | null,
    historyRevision: Number(row.history_revision ?? 0), referenceCheck: (row.reference_check ?? null) as LearningObservation["referenceCheck"],
  };
}
