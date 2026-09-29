import type { LearningObservation, Scope } from "@aistudy/contracts";
import type { EvidenceObservation, EvidenceEligibilityContext } from "@aistudy/domain";
import type { LearningSql } from "./opening-learning-facts";

/** Attribution/check-only revisions retain the last answer event; descendants never qualify ancestors. */
function revisedAnswerRecordedAt(record: LearningObservation, chain: readonly Record<string, unknown>[]): number | null | undefined {
  const rows = new Map(chain.map(row => [String(row.id), row]));
  const visited = new Set<string>();
  let current = rows.get(record.id);
  while (current && current.id !== record.rootObservationId) {
    const id = String(current.id);
    if (visited.has(id)) return null;
    visited.add(id);
    const previous = rows.get(String(current.revises_observation_id));
    if (!previous) return null;
    if (current.answer !== previous.answer) {
      const recordedAt = current.recorded_at ? new Date(current.recorded_at as string | Date).getTime() : Number.NaN;
      return Number.isFinite(recordedAt) ? recordedAt : null;
    }
    current = previous;
  }
  return current ? undefined : null;
}
/** Uses captured identities; a current mutable problem never supplies missing historical identity. */
export async function readOpeningLearningEvidenceContext(db: LearningSql, scope: Scope, record: LearningObservation): Promise<{
  observation: EvidenceObservation; context: EvidenceEligibilityContext;
}> {
  const observation: EvidenceObservation = {
    attemptId: record.attemptId ?? null, problemId: record.problemId ?? null, itemVersionId: record.itemVersionId ?? null,
    courseId: record.courseId, requirementKey: record.requirementKey ?? null,
    startedAt: record.startedAt ? Date.parse(record.startedAt) : null, submittedAt: record.submittedAt ? Date.parse(record.submittedAt) : null,
    assistance: record.assistance, outcome: record.outcome, verdictSource: record.verdictSource,
  };
  const history = await db`SELECT h.attempt_id,h.problem_id,h.level,h.delivered,h.delivered_at FROM opening_help_exposures h
    JOIN opening_learning_sessions l ON l.id=h.session_id AND l.workspace_id=h.workspace_id
    WHERE h.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND l.course_id=(SELECT origin.course_id FROM opening_learning_sessions origin WHERE origin.id=${record.sessionId} AND origin.workspace_id=${scope.workspaceId} AND origin.owner_user_id=${scope.ownerUserId})
      AND (h.attempt_id=${record.attemptId ?? null} OR h.problem_id=${record.problemId ?? null}
        OR (h.attempt_id IS NULL AND h.problem_id IS NULL AND h.session_id=${record.sessionId})) ORDER BY h.created_at,h.id`;
  const context: EvidenceEligibilityContext = {
    helpHistory: { complete: Boolean(record.attemptId), exposures: history.map((h) => ({
      attemptId: h.attempt_id as string | null, problemId: h.problem_id as string | null, level: h.level as "hinted" | "revealed",
      delivered: h.delivered as boolean | null, deliveredAt: h.delivered_at ? new Date(h.delivered_at as string | Date).getTime() : null,
    })) },
    referenceCheck: record.referenceCheck ?? null, version: { applicability: "version_unknown" }, delayedCheck: null,
  };
  const sourceIds = [...new Set([...record.sourceIds, ...Object.keys(record.sourceVersions ?? {}),
    ...[record.referenceSourceId, record.referenceCheck?.referenceId].filter((id): id is string => Boolean(id))])];
  // A corrected head cannot erase an ancestor's privacy references. Version qualification below remains snapshot-local.
  const chain = record.rootObservationId ? await db`SELECT id,revises_observation_id,answer,recorded_at,source_ids,source_versions,reference_source_id,reference_check
    FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND COALESCE(root_observation_id,id)=${record.rootObservationId}` : [];
  if (record.revisesObservationId || (record.rootObservationId && record.id !== record.rootObservationId)) {
    context.helpHistory!.answerRecordedAt = revisedAnswerRecordedAt(record, chain);
  }
  const privacyIds = [...new Set([...sourceIds, ...chain.flatMap(row => [
    ...(row.source_ids as string[] ?? []), ...Object.keys(row.source_versions ?? {}),
    ...[row.reference_source_id, row.reference_check?.referenceId].filter((id): id is string => typeof id === "string"),
  ])])];
  if (privacyIds.length) {
    const excluded = await db`SELECT source_id FROM opening_privacy_exclusions
      WHERE workspace_id=${scope.workspaceId} AND source_id IN ${db(privacyIds)}`;
    if (excluded.length) {
      context.version = { applicability: "privacy_excluded" };
      return { observation, context };
    }
  }
  if (sourceIds.length) {
    const rows = await db`SELECT id,version,upload_state FROM opening_sources
      WHERE workspace_id=${scope.workspaceId} AND id IN ${db(sourceIds)}`;
    if (rows.length !== sourceIds.length || rows.some((s) => s.upload_state !== "uploaded")) context.version = { applicability: "unavailable" };
    else if (record.sourceVersions && sourceIds.every((id) => Number.isInteger(record.sourceVersions?.[id]))) {
      const versions = await db`SELECT source_id,version,availability FROM opening_source_versions
        WHERE workspace_id=${scope.workspaceId} AND source_id IN ${db(sourceIds)}`;
      const unavailable = sourceIds.some((id) => versions.some((v) => v.source_id===id && Number(v.version)===record.sourceVersions![id] && v.availability==='unavailable'));
      if (unavailable) context.version = { applicability: "unavailable" };
      else if (rows.some((s) => Number(s.version) !== record.sourceVersions![String(s.id)])) context.version = { applicability: "changed_needs_check" };
      else if (record.itemVersionId && record.problemId) {
        const items = await db`SELECT v.id, p.problem_id FROM opening_learning_item_versions v
          JOIN opening_problem_refs p ON p.problem_id=v.problem_id AND p.workspace_id=v.workspace_id
            AND p.source_id=v.source_id AND p.source_version=v.source_version AND p.stem_snapshot=v.stem_snapshot
            AND p.chunk_id IS NOT DISTINCT FROM v.chunk_id AND p.physical_page IS NOT DISTINCT FROM v.physical_page AND p.artifact_kind=v.artifact_kind
          WHERE v.id=${record.itemVersionId} AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}`;
        context.version = items.length ? { applicability: "exact", currentItemVersionId: record.itemVersionId } : { applicability: "changed_needs_check" };
      }
    }
  }
  return { observation, context };
}
