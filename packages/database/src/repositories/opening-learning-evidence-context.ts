import { teachingQuestionIdentityMatches } from "./opening-teaching-question";
import { parseOpeningSpanExercise } from "./opening-span-attempt";
import { aiEvaluationSchema, serverEvaluationSchema, type LearningObservation, type Scope } from "@aistudy/contracts";
import { SPAN_REQUIREMENT_KEY, evaluateEvidenceEligibility, examAttemptExposureQualification, parseCanonicalMatrixExercise, parseExamChoiceSpec, type EvidenceObservation, type EvidenceEligibilityContext } from "@aistudy/domain";
import { mapLearningObservation, type LearningSql } from "./opening-learning-facts";
import { openingExamIdentityStateQuery } from "./opening-exam-skill-identity";
import { OpeningExamSprintRepositoryError, parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";
import { readExamSourceExposure } from "./opening-exam-source-exposure";

type Row = Record<string, unknown>;
export type OpeningEvidenceDependencies = {
  helpRevision: number;
  itemMatches: boolean;
  sourceStates: Array<{ sourceId: string; version: number | null; uploaded: boolean; historicalUnavailable: boolean }>;
  privacySourceIds: string[];
};
export type OpeningEvidenceInput = {
  observation: EvidenceObservation;
  context: EvidenceEligibilityContext;
  dependencies: OpeningEvidenceDependencies;
};

/** Attribution/check-only revisions retain the last answer event; descendants never qualify ancestors. */
function revisedAnswerRecordedAt(record: LearningObservation, chain: readonly Row[]): number | null | undefined {
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

/** A changed choice cannot inherit the original attempt's independence, even after changing back. */
function examAnswerUnchanged(record: LearningObservation, chain: readonly Row[], capturedAnswer: unknown): boolean | null {
  if (typeof capturedAnswer !== "string") return null;
  if (record.answer !== capturedAnswer) return false;
  const rows = new Map(chain.map(row => [String(row.id), row]));
  const rootId = record.rootObservationId ?? record.id, visited = new Set<string>();
  let current = rows.get(record.id);
  while (current) {
    const id = String(current.id);
    if (visited.has(id) || typeof current.answer !== "string") return null;
    visited.add(id);
    if (current.answer !== capturedAnswer) return false;
    if (id === rootId) return true;
    current = rows.get(String(current.revises_observation_id));
  }
  return null;
}

function answerEventRevision(record: LearningObservation, chain: readonly Row[]): number | null {
  const rows = new Map(chain.map(row => [String(row.id), row]));
  const seen = new Set<string>();
  let current = rows.get(record.id);
  while (current) {
    if (seen.has(String(current.id))) return null;
    seen.add(String(current.id));
    const previous = rows.get(String(current.revises_observation_id));
    if (!previous || current.answer !== previous.answer) {
      const revision = Number(current.workspace_history_revision);
      return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
    }
    current = previous;
  }
  return null;
}

function catalogueSpec(value: unknown) {
  const matrix = parseCanonicalMatrixExercise(value);
  if (matrix) return matrix;
  return parseOpeningSpanExercise(value) ? value as Record<string, unknown> : null;
}

function references(row: { sourceIds: readonly string[]; sourceVersions?: Record<string, number> | null; referenceSourceId?: string | null; referenceCheck?: { referenceId?: string | null } | null }): string[] {
  return [...new Set([...row.sourceIds, ...Object.keys(row.sourceVersions ?? {}),
    ...[row.referenceSourceId, row.referenceCheck?.referenceId].filter((id): id is string => Boolean(id))])].sort();
}

/** One bounded set of queries for the whole batch, including fixed-R historical heads. */
export async function readOpeningLearningEvidenceContexts(
  db: LearningSql, scope: Scope, records: readonly LearningObservation[], includeRetestProtocols = true,
): Promise<Record<string, OpeningEvidenceInput>> {
  if (!records.length) return {};
  const sessionIds = [...new Set(records.map(row => row.sessionId))];
  const attemptIds = [...new Set(records.flatMap(row => row.attemptId ? [row.attemptId] : []))];
  const problemIds = [...new Set(records.flatMap(row => row.problemId ? [row.problemId] : []))];
  const rootIds = [...new Set(records.map(row => row.rootObservationId ?? row.id))];
  const itemIds = [...new Set(records.flatMap(row => row.itemVersionId ? [row.itemVersionId] : []))];
  const answerConditions = attemptIds.length ? await db`SELECT attempt_id,
      bool_or(COALESCE(payload->'signals' ? 'copied_answer',FALSE)) AS copied_answer,
      bool_or(COALESCE(payload->'signals' ? 'guessed',FALSE)) AS reported_guess
    FROM opening_study_intent_events WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND attempt_id=ANY(${attemptIds}::uuid[]) GROUP BY attempt_id` : [];
  const recordSourceIds = [...new Set(records.flatMap(row => [...row.sourceIds]))];
  const skillLabels = [...new Set(records.map(row => row.skillLabel))];
  const sessions = await db`SELECT id,course_id FROM opening_learning_sessions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id =ANY(${sessionIds}::uuid[])`;
  const origins = new Map(sessions.map(row => [String(row.id), String(row.course_id)]));
  const courseIds = [...new Set(origins.values())];
  const help = courseIds.length ? await db`SELECT h.id,h.session_id,h.attempt_id,h.problem_id,h.level,h.kind,h.delivered,h.delivered_at,h.history_revision,h.workspace_history_revision,h.support_domain,h.context_anchor,h.release_intent,COALESCE(h.course_id,l.course_id) AS course_id
    FROM opening_help_exposures h LEFT JOIN opening_learning_sessions l ON l.id=h.session_id AND l.workspace_id=h.workspace_id
    WHERE h.workspace_id=${scope.workspaceId} AND COALESCE(h.owner_user_id,l.owner_user_id)=${scope.ownerUserId}
      AND h.delivered=TRUE AND (COALESCE(h.course_id,l.course_id) =ANY(${courseIds}::uuid[]) OR (h.course_id IS NULL AND h.session_id IS NULL))
      AND (${attemptIds.length ? db`h.attempt_id =ANY(${attemptIds}::uuid[])` : db`FALSE`}
        OR ${problemIds.length ? db`h.problem_id =ANY(${problemIds}::uuid[])` : db`FALSE`}
        OR (h.attempt_id IS NULL AND h.problem_id IS NULL AND h.session_id =ANY(${sessionIds}::uuid[]))
        OR EXISTS(SELECT 1 FROM opening_learning_item_versions v WHERE v.id=ANY(${itemIds}::uuid[])
          AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.teaching_revision_id IS NOT NULL
          AND h.context_anchor->>'activityId'=v.activity_id::text
          AND h.context_anchor->>'blockId'=v.evaluation_spec->>'blockId'
          AND h.context_anchor->>'contentVersion'=v.evaluation_spec->>'contentVersion')
        OR (h.attempt_id IS NULL AND h.problem_id IS NULL AND EXISTS(SELECT 1 FROM opening_learning_item_versions v
          WHERE v.id=ANY(${itemIds}::uuid[]) AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
            AND v.source_id::text=h.context_anchor->>'sourceId' AND v.source_version::text=h.context_anchor->>'sourceVersion'
            AND (h.context_anchor->>'page' IS NULL OR v.physical_page::text=h.context_anchor->>'page')
            AND (h.context_anchor->>'chunkId' IS NULL OR v.chunk_id::text=h.context_anchor->>'chunkId'))
          OR (h.attempt_id IS NULL AND h.problem_id IS NULL AND h.release_intent->'originReference'->>'skillLabel'=ANY(${skillLabels}::text[])
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(h.release_intent->'originReference'->'sourceRefs','[]'::jsonb)) ref
              WHERE ref->>'sourceId'=ANY(${recordSourceIds}::text[])))))
    ORDER BY h.created_at,h.id` : [];
  const retestIds = [...new Set(records.flatMap(record => record.retestId ? [record.retestId] : []))];
  const retestProtocols = includeRetestProtocols && retestIds.length ? await db`SELECT r.id,r.candidate_id,r.candidate_reference_id,r.course_id,r.skill_label,r.requirement_key,r.not_before_at,r.accepted_at,
      r.learning_protocol AS protocol,to_jsonb(baseline) AS baseline_record,baseline.id AS baseline_id,baseline.recorded_at AS baseline_recorded_at,baseline.submitted_at AS baseline_submitted_at,
      baseline.course_id AS baseline_course_id,baseline.requirement_key AS baseline_requirement_key,
      root.id AS baseline_root_id,COALESCE(root.effective_head_id,root.id)=baseline.id AND COALESCE(baseline.revision_kind,'original')<>'retract' AS baseline_current
    FROM opening_retest_activities r
    JOIN opening_learning_observations baseline ON baseline.id::text=r.learning_protocol->>'baselineObservationId'
      AND baseline.workspace_id=r.workspace_id AND baseline.owner_user_id=r.owner_user_id
    JOIN opening_learning_observations root ON root.id=COALESCE(baseline.root_observation_id,baseline.id)
      AND root.workspace_id=baseline.workspace_id AND root.owner_user_id=baseline.owner_user_id
    WHERE r.workspace_id=${scope.workspaceId} AND r.owner_user_id=${scope.ownerUserId} AND r.purpose='retest'
      AND (r.id=ANY(${retestIds}::uuid[]) OR r.candidate_id=ANY(${retestIds}::uuid[]) OR r.candidate_reference_id=ANY(${retestIds}::uuid[]))` : [];
  const baselineRecords = [...new Map(retestProtocols.map(row => [String(row.baseline_id), mapLearningObservation(row.baseline_record as Row)])).values()];
  const baselineEvidence = baselineRecords.length ? await readOpeningLearningEvidenceContexts(db, scope, baselineRecords, false) : {};
  const baselineEligibility = new Map(Object.entries(baselineEvidence).map(([id, evidence]) => [id, evaluateEvidenceEligibility(evidence.observation, evidence.context)]));
  const intervalExposures = retestProtocols.length ? await db`SELECT r.id AS retest_id,o.id AS observation_id,count(h.id)::int AS recorded_count,
      (SELECT count(*)::int FROM opening_learning_attempts practice WHERE practice.workspace_id=o.workspace_id AND practice.owner_user_id=o.owner_user_id
        AND practice.course_id=o.course_id AND practice.requirement_key IS NOT DISTINCT FROM o.requirement_key AND practice.id<>o.attempt_id
        AND practice.started_at>baseline.recorded_at AND practice.started_at<=o.started_at) AS recorded_practice_count
    FROM opening_learning_observations o JOIN opening_retest_activities r ON r.id=o.retest_id AND r.workspace_id=o.workspace_id AND r.owner_user_id=o.owner_user_id
    JOIN opening_learning_observations baseline ON baseline.id::text=r.learning_protocol->>'baselineObservationId'
      AND baseline.workspace_id=o.workspace_id AND baseline.owner_user_id=o.owner_user_id
    LEFT JOIN opening_help_exposures h ON h.workspace_id=o.workspace_id AND COALESCE(h.owner_user_id,
        (SELECT l.owner_user_id FROM opening_learning_sessions l WHERE l.id=h.session_id AND l.workspace_id=h.workspace_id))=o.owner_user_id
      AND h.delivered=TRUE AND h.support_domain<>'language' AND (h.course_id IS NULL OR h.course_id=o.course_id) AND COALESCE(h.released_at,h.delivered_at)>baseline.recorded_at AND COALESCE(h.released_at,h.delivered_at)<=o.started_at
      AND (h.attempt_id=o.attempt_id OR h.problem_id=o.problem_id OR h.context_anchor->>'sourceId'=ANY(o.source_ids::text[])
        OR h.release_intent->'originReference'->>'skillLabel'=o.skill_label
        OR EXISTS(SELECT 1 FROM opening_learning_sessions l WHERE l.id=h.session_id AND l.workspace_id=h.workspace_id
          AND l.course_id=o.course_id AND l.skill_label=o.skill_label))
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND o.id=ANY(${records.map(record => record.id)}::uuid[])
    GROUP BY r.id,o.id,baseline.recorded_at` : [];
  // Catalogue help is a retrievable receipt, not an invented assistant turn.
  // Keep the immutable exposure/protocol link even if the observation is revised.
  const examRows = courseIds.length && (attemptIds.length || problemIds.length) ? await db`SELECT e.id AS exam_link_id,
      e.learning_attempt_id AS attempt_id,e.exam_attempt_id,e.first_family_exposure,e.delayed_earliest_at,e.submitted_answer,
      a.session_id,a.course_id,a.problem_id,a.item_version_id,
      s.pack_snapshot->>'id' AS exam_pack_id,s.pack_snapshot->>'version' AS exam_pack_version,
      s.id AS exam_sprint_id,s.pack_snapshot AS exam_pack_snapshot,s.state AS exam_sprint_state,
      h.id AS receipt_id,h.kind,h.delivered_at,h.history_revision
    FROM opening_exam_attempt_links e
    JOIN opening_exam_sprints s ON s.id=e.sprint_id
    JOIN opening_learning_attempts a ON a.id=e.learning_attempt_id
      AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id
    JOIN opening_learning_sessions l ON l.id=a.session_id AND l.workspace_id=a.workspace_id
      AND l.owner_user_id=a.owner_user_id AND l.course_id=a.course_id
    LEFT JOIN opening_exam_help_receipts h ON h.attempt_link_id=e.id
    WHERE s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId}
      AND a.course_id =ANY(${courseIds}::uuid[])
      AND (${attemptIds.length ? db`a.id =ANY(${attemptIds}::uuid[])` : db`FALSE`}
        OR ${problemIds.length ? db`a.problem_id =ANY(${problemIds}::uuid[])` : db`FALSE`})
    ORDER BY e.id,h.delivered_at,h.id` : [];
  const examLinks = new Map(examRows.map(row => [String(row.attempt_id), row]));
  const examSnapshots = new Map<string, ReturnType<typeof parseExamSprintSnapshot> | null>();
  for (const row of examRows) {
    if (row.exam_sprint_state !== undefined && !examSnapshots.has(String(row.exam_sprint_id))) {
      try {
        examSnapshots.set(String(row.exam_sprint_id), parseExamSprintSnapshot(row.exam_pack_snapshot, row.exam_sprint_state));
      } catch (error) {
        if (!(error instanceof OpeningExamSprintRepositoryError)) throw error;
        // An unprovable Sprint reference is unknown evidence, never proof of no help.
        examSnapshots.set(String(row.exam_sprint_id), null);
      }
    }
  }
  const examIdentities = await db`SELECT * FROM (${openingExamIdentityStateQuery(db, scope)}) identity
    WHERE identity.attempt_id=ANY(${attemptIds}::uuid[]) OR identity.observation_id=ANY(${rootIds}::uuid[])`;
  const identitiesByAttempt = new Map(examIdentities.filter(row => row.attempt_id != null).map(row => [String(row.attempt_id), row]));
  const identitiesByRoot = new Map(examIdentities.filter(row => row.observation_id != null).map(row => [String(row.observation_id), row]));
  const examHelp: Row[] = examRows.filter(row => row.receipt_id != null).map(row => ({
    id: `exam-help:${row.receipt_id}`, session_id: row.session_id, attempt_id: row.attempt_id,
    problem_id: row.problem_id, course_id: row.course_id,
    kind: row.kind === "solution" ? "solution" : "hint",
    level: row.kind === "solution" ? "revealed" : "hinted", delivered: true,
    delivered_at: row.delivered_at, history_revision: row.history_revision,
  }));
  const chain = await db`SELECT id,root_observation_id,revises_observation_id,answer,recorded_at,workspace_history_revision,source_ids,source_versions,reference_source_id,reference_check
    FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND COALESCE(root_observation_id,id) =ANY(${rootIds}::uuid[])`;
  const chains = new Map<string, Row[]>();
  for (const row of chain) {
    const rootId = String(row.root_observation_id ?? row.id);
    const entries = chains.get(rootId) ?? [];
    entries.push(row); chains.set(rootId, entries);
  }
  const recordSources = new Map(records.map(row => [row.id, references(row)]));
  const sourceIds = [...new Set([...recordSources.values()].flat())].sort();
  const privacyByRoot = new Map<string, string[]>();
  for (const rootId of rootIds) privacyByRoot.set(rootId, [...new Set((chains.get(rootId) ?? []).flatMap(row => references({
    sourceIds: (row.source_ids ?? []) as string[], sourceVersions: row.source_versions as Record<string, number> | null,
    referenceSourceId: row.reference_source_id as string | null, referenceCheck: row.reference_check as { referenceId?: string } | null,
  })))].sort());
  const privacyIds = [...new Set([...sourceIds, ...[...privacyByRoot.values()].flat()])];
  const excludedRows = privacyIds.length ? await db`SELECT source_id FROM opening_privacy_exclusions
    WHERE workspace_id=${scope.workspaceId} AND source_id =ANY(${privacyIds}::uuid[])` : [];
  const excluded = new Set(excludedRows.map(row => String(row.source_id)));
  const sources = sourceIds.length ? await db`SELECT id,version,upload_state FROM opening_sources
    WHERE workspace_id=${scope.workspaceId} AND id =ANY(${sourceIds}::uuid[])` : [];
  const sourceById = new Map(sources.map(row => [String(row.id), row]));
  const versions = sourceIds.length ? await db`SELECT source_id,version,availability FROM opening_source_versions
    WHERE workspace_id=${scope.workspaceId} AND source_id =ANY(${sourceIds}::uuid[])` : [];
  const unavailableVersions = new Set(versions.filter(row => row.availability === "unavailable").map(row => `${row.source_id}:${row.version}`));
  const items = itemIds.length ? await db`SELECT v.id,p.problem_id,v.course_id,v.evaluation_spec,v.source_id,v.source_version,v.physical_page,v.chunk_id,v.teaching_revision_id,v.teaching_block_id FROM opening_learning_item_versions v
    LEFT JOIN opening_problem_refs p ON p.problem_id=v.problem_id AND p.workspace_id=v.workspace_id
      AND p.source_id IS NOT DISTINCT FROM v.source_id AND p.source_version IS NOT DISTINCT FROM v.source_version AND p.stem_snapshot=v.stem_snapshot
      AND p.teaching_revision_id IS NOT DISTINCT FROM v.teaching_revision_id AND p.teaching_block_id IS NOT DISTINCT FROM v.teaching_block_id
      AND ${teachingQuestionIdentityMatches(db)}
      AND p.chunk_id IS NOT DISTINCT FROM v.chunk_id AND p.physical_page IS NOT DISTINCT FROM v.physical_page AND p.artifact_kind=v.artifact_kind
    WHERE v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.id =ANY(${itemIds}::uuid[])` : [];
  const matchingItems = new Set(items.filter(row => row.problem_id != null).map(row => String(row.id)));
  const examItems = new Map(items.flatMap(row => {
    const spec = parseExamChoiceSpec(row.evaluation_spec);
    return spec ? [[String(row.id), spec] as const] : [];
  }));
  const catalogueItems = new Map(items.flatMap(row => {
    const spec = catalogueSpec(row.evaluation_spec);
    return spec && row.course_id ? [[String(row.id), { spec, courseId: String(row.course_id) }] as const] : [];
  }));
  const catalogueSpecs = [...new Map([...catalogueItems.values()].map(item => [JSON.stringify(item.spec), item.spec])).values()];
  const catalogueCourses = [...new Set([...catalogueItems.values()].map(item => item.courseId))];
  // First two original feedback events per canonical question suffice: exclude this
  // attempt, then use the earliest other event. Revisions never erase past delivery.
  const automaticFeedback = catalogueSpecs.length ? await db`WITH ranked AS (
    SELECT o.id,o.attempt_id,o.problem_id,o.recorded_at,v.course_id,v.evaluation_spec,
      row_number() OVER (PARTITION BY v.course_id,v.evaluation_spec ORDER BY o.recorded_at,o.id) AS feedback_rank
    FROM opening_learning_observations o
    JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND v.course_id =ANY(${catalogueCourses}::uuid[])
      AND v.evaluation_spec IN (SELECT value FROM jsonb_array_elements(${JSON.stringify(catalogueSpecs)}::text::jsonb))
      AND o.verdict_source='deterministic' AND o.server_evaluation->>'decision' IN ('correct','incorrect')
      AND o.attempt_id IS NOT NULL AND o.recorded_at IS NOT NULL
  ) SELECT * FROM ranked WHERE feedback_rank<=2` : [];
  const feedbackByCatalogue = new Map<string, Row[]>();
  for (const row of automaticFeedback) {
    const spec = catalogueSpec(row.evaluation_spec);
    if (!spec) continue;
    const key = `${row.course_id}:${JSON.stringify(spec)}`;
    const entries = feedbackByCatalogue.get(key) ?? [];
    entries.push(row); feedbackByCatalogue.set(key, entries);
  }
  // Reference comparisons expose answers even when low-trust or subsequently revised.
  // Read immutable events, not only current heads: corrections cannot erase exposure.
  const priorReferenceHeads = problemIds.length ? await db`SELECT o.id, o.attempt_id, o.problem_id, o.item_version_id, o.verdict_source,
      o.submitted_at, o.recorded_at, o.workspace_history_revision,
      (o.verdict_source='ai_graded' OR o.submitted_intent ? 'aiGrading') AS ai_feedback
    FROM opening_learning_observations o
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND o.problem_id =ANY(${problemIds}::uuid[])
      AND (o.verdict_source IN ('reference_checked','ai_graded') OR o.reference_check IS NOT NULL OR o.submitted_intent ? 'aiGrading')
      AND o.attempt_id IS NOT NULL
      AND (o.revision_kind IS DISTINCT FROM 'retract')` : [];
  // Pre-upgrade teaching attempts did not share a canonical problem. Their
  // delivered answers remain exposure to this exact activity/block/version.
  const legacyTeachingFeedback = items.some(item => item.teaching_revision_id) ? await db`SELECT DISTINCT
      o.id,o.attempt_id,v.problem_id,v.id AS item_version_id,o.verdict_source,o.submitted_at,o.recorded_at,o.workspace_history_revision,
      (o.verdict_source='ai_graded' OR o.submitted_intent ? 'aiGrading') AS ai_feedback
    FROM opening_learning_item_versions v
    JOIN opening_learning_attempts a ON a.activity_id=v.activity_id AND a.workspace_id=v.workspace_id AND a.owner_user_id=v.owner_user_id
      AND a.create_intent->'teachingBlock'->>'blockId'=v.evaluation_spec->>'blockId'
      AND a.create_intent->'teachingBlock'->>'contentVersion'=v.evaluation_spec->>'contentVersion'
    JOIN opening_learning_observations o ON o.attempt_id=a.id AND o.workspace_id=a.workspace_id AND o.owner_user_id=a.owner_user_id
    WHERE v.id=ANY(${itemIds}::uuid[]) AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId}
      AND v.teaching_revision_id IS NOT NULL AND a.problem_id IS DISTINCT FROM v.problem_id
      AND (o.verdict_source IN ('reference_checked','ai_graded') OR o.reference_check IS NOT NULL OR o.submitted_intent ? 'aiGrading')
      AND o.revision_kind IS DISTINCT FROM 'retract'` : [];
  const priorsByProblem = new Map<string, Row[]>();
  for (const row of [...priorReferenceHeads, ...legacyTeachingFeedback]) {
    const key = String(row.problem_id);
    const entries = priorsByProblem.get(key) ?? [];
    entries.push(row); priorsByProblem.set(key, entries);
  }
  const helpByAttempt = new Map<string, Row[]>(), helpByProblem = new Map<string, Row[]>(), legacyHelp = new Map<string, Row[]>();
  const add = (map: Map<string, Row[]>, key: string, row: Row) => { const entries = map.get(key) ?? []; entries.push(row); map.set(key, entries); };
  for (const row of [...help, ...examHelp]) {
    if (row.attempt_id) add(helpByAttempt, `${row.course_id}:${row.attempt_id}`, row);
    if (row.problem_id && !(row.release_intent as { originReference?: { possibleOpenAttemptOnly?: boolean } } | null)?.originReference?.possibleOpenAttemptOnly) add(helpByProblem, `${row.course_id}:${row.problem_id}`, row);
    if (row.attempt_id == null && row.problem_id == null) add(legacyHelp, String(row.session_id), row);
  }
  const result: Record<string, OpeningEvidenceInput> = {};
  for (const record of records) {
    const origin = origins.get(record.sessionId);
    const item = items.find(row => row.id === record.itemVersionId);
    const sourceHelp = item ? help.filter(row => {
      if (row.attempt_id != null || row.problem_id != null || row.course_id != null && row.course_id !== record.courseId) return false;
      const anchor = row.context_anchor as { sourceId?: string; sourceVersion?: number; page?: number | null; chunkId?: string | null } | null;
      return anchor != null && anchor.sourceId === item.source_id && anchor.sourceVersion === Number(item.source_version)
        && (anchor.page == null || anchor.page === item.physical_page) && (anchor.chunkId == null || anchor.chunkId === item.chunk_id);
    }) : [];
    const uncertainSourceHelp = help.filter(row => {
      if (row.attempt_id != null || row.problem_id != null || row.course_id != null && row.course_id !== record.courseId) return false;
      const ref = (row.release_intent as { originReference?: { skillLabel?: string; requirementKey?: string; sourceRefs?: Array<{ sourceId: string; sourceVersion: number | null }> } } | null)?.originReference;
      return ref?.skillLabel === record.skillLabel && (!ref.requirementKey || ref.requirementKey === record.requirementKey)
        && Boolean(ref.sourceRefs?.some(source => record.sourceIds.includes(source.sourceId)
          && (source.sourceVersion == null || source.sourceVersion === record.sourceVersions?.[source.sourceId])));
    });
    const teachingSpec = item?.teaching_revision_id ? item.evaluation_spec as { activityId: string; blockId: string; contentVersion: number } : null;
    const teachingHelp: Row[] = teachingSpec ? help.filter(row => {
      const anchor = row.context_anchor as { activityId?: string; blockId?: string; contentVersion?: number } | null;
      return anchor?.activityId === teachingSpec.activityId && anchor.blockId === teachingSpec.blockId && anchor.contentVersion === teachingSpec.contentVersion;
    }).map(row => ({ ...row, problem_id: record.problemId, same_question: true })) : [];
    const history = [...new Map([
      ...sourceHelp, ...uncertainSourceHelp,
      ...(record.attemptId ? helpByAttempt.get(`${origin}:${record.attemptId}`) ?? [] : []),
      ...(record.problemId ? helpByProblem.get(`${origin}:${record.problemId}`) ?? [] : []),
      ...(legacyHelp.get(record.sessionId) ?? []), ...teachingHelp,
    ].map(row => [String(row.id), row])).values()];
    if (record.problemId) {
      for (const prior of priorsByProblem.get(record.problemId) ?? []) {
        if (String(prior.id) === record.id) continue;
        const aiFeedback = prior.ai_feedback === true || prior.verdict_source === "ai_graded";
        if (record.attemptId && prior.attempt_id === record.attemptId && !aiFeedback) continue;
        if (record.itemVersionId && prior.item_version_id && String(prior.item_version_id) !== record.itemVersionId) continue;
        // A check revision retains the original submission time. Its exposure
        // happened when the check was recorded, not at that earlier submission.
        const checkedAt = prior.recorded_at;
        const checkedMs = checkedAt ? new Date(checkedAt as string | Date).getTime() : Number.NaN;
        // Keep concurrent checks too. The domain distinguishes prior exposure,
        // help during this answer and checks delivered after its capture time.
        history.push({
          id: `prior-reference:${prior.id}`,
          attempt_id: prior.attempt_id,
          problem_id: prior.problem_id,
          level: aiFeedback ? "hinted" : "revealed",
          kind: aiFeedback ? "evaluation_feedback" : "solution",
          ...(aiFeedback ? { same_question: true, workspace_history_revision: prior.workspace_history_revision } : {}),
          delivered: true,
          delivered_at: Number.isFinite(checkedMs) ? checkedAt : null,
          history_revision: 0,
        });
      }
    }
    const catalogue = record.itemVersionId ? catalogueItems.get(record.itemVersionId) : undefined;
    for (const prior of catalogue ? feedbackByCatalogue.get(`${catalogue.courseId}:${JSON.stringify(catalogue.spec)}`) ?? [] : []) {
      if (prior.attempt_id === record.attemptId) continue;
      history.push({ id: `catalogue-feedback:${prior.id}`, attempt_id: prior.attempt_id, problem_id: prior.problem_id,
        kind: "evaluation_feedback", same_question: true, level: "hinted", delivered: true,
        delivered_at: prior.recorded_at, history_revision: 0 });
    }
    const observation: EvidenceObservation = {
      observationId: record.id, attemptId: record.attemptId ?? null, problemId: record.problemId ?? null, itemVersionId: record.itemVersionId ?? null,
      assessmentDomain: record.requirementKey?.startsWith("language:") ? "language" : "math",
      courseId: record.courseId, requirementKey: record.requirementKey ?? null,
      startedAt: record.startedAt ? Date.parse(record.startedAt) : null, submittedAt: record.submittedAt ? Date.parse(record.submittedAt) : null,
      assistance: record.assistance, outcome: record.outcome, verdictSource: record.verdictSource,
    };
    const declaredConditions = answerConditions.find(row => row.attempt_id === record.attemptId);
    const context: EvidenceEligibilityContext = {
      selfReportedAnswerConditions: { copiedAnswer: declaredConditions?.copied_answer === true, reportedGuess: declaredConditions?.reported_guess === true },
      serverEvaluation: serverEvaluationSchema.safeParse(record.serverEvaluation).data ?? null,
      aiEvaluation: aiEvaluationSchema.safeParse(record.aiEvaluation).data ?? null,
      // Every existing manual-check write is learner-owned. Persisted JSON and
      // historical checker ids cannot grant independent-review authority.
      referenceCheckAuthority: "learner",
      helpHistory: { complete: Boolean(record.attemptId), exposures: history.map(row => ({
        ...(row.support_domain === "language" || row.support_domain === "math" || row.support_domain === "unknown" ? { supportDomain: row.support_domain } : {}),
        ...(row.workspace_history_revision != null && answerEventRevision(record, chains.get(record.rootObservationId ?? record.id) ?? []) != null
          ? { serverOrder: Number(row.workspace_history_revision) < answerEventRevision(record, chains.get(record.rootObservationId ?? record.id) ?? [])! ? "before_answer" as const : "after_answer" as const } : {}),
        attemptId: row.attempt_id as string | null, problemId: (row.release_intent as { originReference?: { possibleOpenAttemptOnly?: boolean } } | null)?.originReference?.possibleOpenAttemptOnly ? null : row.problem_id as string | null,
        level: row.level as "hinted" | "revealed",
        kind: (row.kind as "instruction" | "hint" | "solution" | "evaluation_feedback" | null | undefined) ?? "hint",
        ...(row.same_question === true ? { sameQuestion: true } : {}),
        delivered: row.delivered as boolean | null,
        deliveredAt: row.delivered_at ? new Date(row.delivered_at as string | Date).getTime() : null,
      })) }, referenceCheck: record.referenceCheck ?? null, version: { applicability: "version_unknown" }, delayedCheck: null,
    };
    if (record.retestId && record.requirementKey === SPAN_REQUIREMENT_KEY && record.attemptId) {
      const matchingRetests = retestProtocols.filter(row => row.id === record.retestId || row.candidate_id === record.retestId || row.candidate_reference_id === record.retestId);
      const retest = matchingRetests.length === 1 ? matchingRetests[0] : undefined;
      const protocol = retest?.protocol as { protocolId?: string; baselineObservationId?: string; baselineRootId?: string; priorAnswerPolicy?: string } | undefined;
      const earliestAt = retest?.not_before_at == null ? NaN : new Date(retest.not_before_at as Date).getTime();
      const baselineAt = retest?.baseline_recorded_at == null || retest.baseline_submitted_at == null ? NaN
        : Math.max(new Date(retest.baseline_recorded_at as Date).getTime(), new Date(retest.baseline_submitted_at as Date).getTime());
      if (retest?.accepted_at && protocol?.protocolId === "span-delayed-3d-v1" && protocol.priorAnswerPolicy === "require_unseen_problem"
        && protocol.baselineObservationId === retest.baseline_id && protocol.baselineRootId === retest.baseline_root_id && retest.baseline_current === true
        && retest.course_id === record.courseId && retest.baseline_course_id === record.courseId && retest.skill_label === record.skillLabel
        && retest.requirement_key === record.requirementKey && retest.baseline_requirement_key === record.requirementKey
        && Number.isFinite(earliestAt) && Number.isFinite(baselineAt) && earliestAt >= baselineAt + 3 * 24 * 60 * 60 * 1000) {
        const baseline = baselineEligibility.get(String(retest.baseline_id));
        context.delayedCheck = { protocolId: protocol.protocolId, attemptId: record.attemptId, earliestAt, priorAnswerPolicy: "require_unseen_problem",
          baselineEstablished: baseline?.independentAttempt === "yes" && baseline.verifiedCorrect === "yes" && baseline.usableForCurrentVersion === "yes",
          ...(record.startedAt ? { intervalExposure: { from: baselineAt, to: Date.parse(record.startedAt), complete: false,
            recordedCount: Number(intervalExposures.find(row => row.observation_id === record.id)?.recorded_count ?? 0),
            recordedPracticeCount: Number(intervalExposures.find(row => row.observation_id === record.id)?.recorded_practice_count ?? 0) } } : {}) };
      }
    }
    if (context.serverEvaluation?.evaluatorVersion === "span-exact-v1") {
      const span = parseOpeningSpanExercise(item?.evaluation_spec);
      if (!span || record.requirementKey !== SPAN_REQUIREMENT_KEY) {
        context.serverEvaluation = null;
        context.helpHistory!.complete = false;
      }
    }
    const examSpec = record.itemVersionId ? examItems.get(record.itemVersionId) : undefined;
    const examLink = record.attemptId ? examLinks.get(record.attemptId) : undefined;
    const examSnapshot = examLink ? examSnapshots.get(String(examLink.exam_sprint_id)) : undefined;
    const examCapture = examSnapshot?.state.attempts.find(attempt => attempt.id === examLink?.exam_attempt_id);
    const examQualification = examSnapshot && examCapture
      ? examAttemptExposureQualification(examCapture, examSnapshot.state, examSnapshot.pack) : undefined;
    const examIdentity = (record.attemptId ? identitiesByAttempt.get(record.attemptId) : undefined)
      ?? identitiesByRoot.get(record.rootObservationId ?? record.id);
    const identityCurrent = examIdentity ? examIdentity.identity_current === true && examIdentity.requirement_key === record.requirementKey
      : !(examSpec || examLink || record.serverEvaluation?.evaluatorVersion === "exam-choice-exact-v1"
        || record.requirementKey?.startsWith("exam-skill:"));
    const linkedExam = examSpec && examLink && examLink.session_id === record.sessionId
      && examLink.problem_id === record.problemId && examLink.item_version_id === record.itemVersionId
      && examLink.exam_pack_id === examSpec.packId && examLink.exam_pack_version === examSpec.packVersion
      && (!examSnapshot || examCapture?.questionId === examSpec.questionId)
      && typeof examLink.first_family_exposure === "boolean";
    if (linkedExam) {
      let exposureCoverage: "legacy_untracked_source" | "unverifiable" | undefined = examSnapshot === null ? "unverifiable" : undefined;
      if (examCapture?.exposureCoverage && examSnapshot) {
        const coverage = examCapture.exposureCoverage;
        const classification = await readExamSourceExposure(db, scope, String(examLink.exam_sprint_id), examSnapshot.pack, examCapture.id);
        exposureCoverage = coverage.kind === "legacy_untracked_source" && classification?.kind === "legacy_untracked_source"
          && coverage.packSourceId === classification.packSourceId && coverage.sourceVersion === classification.sourceVersion
          ? "legacy_untracked_source" : "unverifiable";
      }
      context.examAttempt = {
        firstFamilyExposure: examQualification ? examQualification.firstFamilyExposure : examSnapshot === null
          ? null : examLink.first_family_exposure as boolean,
        ...(examSnapshot !== undefined ? {
          lessonAssistance: examQualification?.lessonAssistance ?? null,
          partialExample: examQualification?.partialExample ?? null,
        } : {}),
        ...(exposureCoverage ? { exposureCoverage } : {}),
        answerUnchanged: examAnswerUnchanged(record, chains.get(record.rootObservationId ?? record.id) ?? [], examLink.submitted_answer),
      };
      const earliestAt = examLink.delayed_earliest_at == null ? Number.NaN : new Date(examLink.delayed_earliest_at as string | Date).getTime();
      if (Number.isFinite(earliestAt)) context.delayedCheck = {
        protocolId: "exam-sprint-24h-v1", attemptId: record.attemptId!, earliestAt, priorAnswerPolicy: "require_unseen_problem",
      };
    } else if (examSpec || record.serverEvaluation?.evaluatorVersion === "exam-choice-exact-v1" || examLink) {
      // A detached/mismatched catalogue item cannot prove complete exposure history.
      context.helpHistory!.complete = false;
      if (context.serverEvaluation?.evaluatorVersion === "exam-choice-exact-v1") context.serverEvaluation = null;
    }
    const rootId = record.rootObservationId ?? record.id;
    if (record.revisesObservationId || record.id !== rootId) context.helpHistory!.answerRecordedAt = revisedAnswerRecordedAt(record, chains.get(rootId) ?? []);
    const ids = recordSources.get(record.id)!;
    const privacySourceIds = [...new Set([...ids, ...(privacyByRoot.get(rootId) ?? [])])].sort();
    const sourceStates = ids.map(sourceId => {
      const source = sourceById.get(sourceId);
      return { sourceId, version: source ? Number(source.version) : null, uploaded: source?.upload_state === "uploaded",
        historicalUnavailable: unavailableVersions.has(`${sourceId}:${record.sourceVersions?.[sourceId]}`) };
    });
    // For paper registrations without an item, this existing cache dependency also
    // records their explicit skill identity. Historical item matching stays unchanged.
    const itemMatches = Boolean(record.itemVersionId ? matchingItems.has(record.itemVersionId) : examIdentity) && identityCurrent;
    if (privacySourceIds.some(id => excluded.has(id))) context.version = { applicability: "privacy_excluded" };
    else if (ids.length) {
      if (sourceStates.some(source => !source.uploaded)) context.version = { applicability: "unavailable" };
      else if (record.sourceVersions && ids.every(id => Number.isInteger(record.sourceVersions?.[id]))) {
        if (sourceStates.some(source => source.historicalUnavailable)) context.version = { applicability: "unavailable" };
        else if (sourceStates.some(source => source.version !== record.sourceVersions![source.sourceId])) context.version = { applicability: "changed_needs_check" };
        else if (record.itemVersionId && record.problemId) context.version = itemMatches
          ? { applicability: "exact", currentItemVersionId: record.itemVersionId } : { applicability: "changed_needs_check" };
      }
    }
    else if (record.itemVersionId && record.problemId && item && item.source_id == null) {
      context.version = itemMatches ? { applicability: "exact", currentItemVersionId: record.itemVersionId }
        : { applicability: "changed_needs_check" };
    }
    if (!identityCurrent && context.version?.applicability !== "privacy_excluded") context.version = { applicability: "unavailable" };
    result[record.id] = { observation, context, dependencies: {
      helpRevision: history.reduce((latest, row) => Math.max(latest, Number(row.history_revision ?? 0)), 0),
      itemMatches, sourceStates, privacySourceIds,
    } };
  }
  return result;
}

/** Scalar callers share the batch semantic owner; mutable data never supplies missing historical identity. */
export async function readOpeningLearningEvidenceContext(db: LearningSql, scope: Scope, record: LearningObservation): Promise<OpeningEvidenceInput> {
  return (await readOpeningLearningEvidenceContexts(db, scope, [record]))[record.id]!;
}
