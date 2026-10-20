import { createHash } from "node:crypto";
import type { Scope } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { assembleLearnerState, type LearnerState, type LearnerMeasurementFeature, spanProblemStem, type TransferSpecification } from "@aistudy/domain";
import { mapLearningObservation, learningError } from "./opening-learning-facts";
import { parseOpeningSpanExercise } from "./opening-span-attempt";
import { parseMeasurementItem } from "./opening-measurement-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";

/** Caller owns the read-only repeatable-read transaction; this function never repairs projections. */
export async function readOpeningLearnerState(tx: TransactionSql, scope: Scope,
  input: { courseId?: string; limit?: number } = {}): Promise<LearnerState> {
  const [owner] = await tx`SELECT id,clock_timestamp() AS data_as_of FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  if (!owner) throw learningError("NOT_FOUND", "workspace not found");
  if (input.courseId) {
    const [course] = await tx`SELECT id FROM courses WHERE id=${input.courseId} AND workspace_id=${scope.workspaceId} AND archived_at IS NULL`;
    if (!course) throw learningError("NOT_FOUND", "course not found");
  }
  const rows = await tx`SELECT o.* FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      AND COALESCE(root.effective_head_id,root.id)=o.id
    JOIN courses c ON c.id=o.course_id AND c.workspace_id=o.workspace_id AND c.archived_at IS NULL
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND COALESCE(o.revision_kind,'original')<>'retract'
      AND ${input.courseId ? tx`o.course_id=${input.courseId}` : tx`TRUE`}
    ORDER BY o.submitted_at NULLS FIRST,o.occurred_at,o.id`;
  const mapped = rows.map(mapLearningObservation);
  const contexts = await readOpeningLearningEvidenceContexts(tx, scope, mapped);
  const observations = mapped.filter(row => contexts[row.id]?.context.version?.applicability !== "privacy_excluded");
  const evidenceContexts = Object.fromEntries(observations.map(row => [row.id, contexts[row.id]!]));
  const sourceIds = [...new Set(observations.flatMap(row => [...row.sourceIds, ...Object.keys(row.sourceVersions ?? {})]))];
  const currentSources = sourceIds.length ? await tx`SELECT id,version FROM opening_sources s WHERE workspace_id=${scope.workspaceId}
    AND id=ANY(${sourceIds}::uuid[]) AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) ORDER BY s.id` : [];
  const currentSourceVersions = Object.fromEntries(currentSources.map(row => [String(row.id), Number(row.version)]));
  const itemIds = observations.flatMap(row => row.itemVersionId ? [row.itemVersionId] : []);
  const items = itemIds.length ? await tx`SELECT id,evaluation_spec,stem_snapshot FROM opening_learning_item_versions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id=ANY(${itemIds}::uuid[])` : [];
  const transferSpecifications: Record<string, TransferSpecification> = {}, observationFamilies: Record<string, string> = {};
  for (const item of items) {
    const spec = item.evaluation_spec as { kind?: string; problemId?: string; version?: number; familyId?: string; transfer?: { fromFamilyId: string; changes: string[] } | null; knowledgeComponents?: string[] } | null;
    const problem = parseOpeningSpanExercise(item.evaluation_spec);
    if (!problem || problem.familyId !== spec?.familyId || item.stem_snapshot !== spanProblemStem(problem)) continue;
    for (const observation of observations.filter(row => row.itemVersionId === item.id)) {
      observationFamilies[observation.id] = problem.familyId;
      if (spec?.transfer && Array.isArray(spec.knowledgeComponents)
        && spec.transfer.fromFamilyId === problem.transfer?.fromFamilyId
        && JSON.stringify(spec.transfer.changes) === JSON.stringify(problem.transfer.changes)
        && JSON.stringify(spec.knowledgeComponents) === JSON.stringify(problem.knowledgeComponents)) {
        transferSpecifications[observation.id] = { ...spec.transfer, familyId: problem.familyId, knowledgeComponents: spec.knowledgeComponents };
      }
    }
  }
  const visibleHeads = observations.map(row => row.id);
  const projections = await tx`SELECT count(*)::int AS count FROM opening_learning_eligibility p
    JOIN opening_learning_observations o ON o.id=p.head_observation_id AND o.workspace_id=p.workspace_id AND o.owner_user_id=p.owner_user_id
    WHERE p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
      AND p.head_observation_id=ANY(${visibleHeads}::uuid[])
      AND ${input.courseId ? tx`o.course_id=${input.courseId}` : tx`TRUE`}`;
  const measurements = await tx`SELECT a.*,t.course_id,t.protocol_version,t.bank_version FROM opening_measurement_attempts a
    JOIN opening_measurement_trials t ON t.id=a.trial_id JOIN courses c ON c.id=t.course_id AND c.workspace_id=t.workspace_id AND c.archived_at IS NULL
    WHERE t.workspace_id=${scope.workspaceId} AND t.owner_user_id=${scope.ownerUserId}
      AND ${input.courseId ? tx`t.course_id=${input.courseId}` : tx`TRUE`} ORDER BY a.presented_at,a.ordinal,a.id`;
  const measurementFeatures: LearnerMeasurementFeature[] = measurements.map(row => {
    const item = parseMeasurementItem(row.item_snapshot);
    return { attemptId: String(row.id), trialId: String(row.trial_id), courseId: String(row.course_id), ordinal: Number(row.ordinal),
      itemId: item.id, itemVersion: item.version, skillId: item.skillId, familyId: item.familyId, phase: item.phase,
      protocolVersion: String(row.protocol_version), bankVersion: String(row.bank_version), presentedAt: new Date(row.presented_at as Date).toISOString(),
      answeredAt: row.answered_at == null ? null : new Date(row.answered_at as Date).toISOString(), outcome: row.outcome as LearnerMeasurementFeature["outcome"],
      firstAttempt: Boolean(row.first_attempt), helpEvents: row.help_events as unknown[], retractedAt: row.retracted_at == null ? null : new Date(row.retracted_at as Date).toISOString() };
  });
  // Source/privacy/help changes can bypass a course history counter. Bind the version to
  // the actual qualified read inputs, so an old decision cannot survive those changes.
  const stateVersion = createHash("sha256").update(JSON.stringify({ observations, evidenceContexts, measurementFeatures, currentSourceVersions, transferSpecifications, observationFamilies })).digest("hex");
  return assembleLearnerState({ evidence: { observations, evidenceContexts }, stateVersion,
    dataAsOf: new Date(owner.data_as_of as Date).toISOString(), persistedRows: Number(projections[0]?.count ?? 0), limit: input.limit, measurementFeatures, currentSourceVersions, transferSpecifications, observationFamilies });
}

export function createOpeningLearnerStateService(sql: Sql) {
  return { read: (scope: Scope, input: { courseId?: string; limit?: number } = {}): Promise<LearnerState> =>
    sql.begin("isolation level repeatable read read only", tx => readOpeningLearnerState(tx, scope, input)) as Promise<LearnerState> };
}
