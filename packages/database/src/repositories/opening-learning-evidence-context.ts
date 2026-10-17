import { serverEvaluationSchema, type LearningObservation, type Scope } from "@aistudy/contracts";
import { parseCanonicalMatrixExercise, parseExamChoiceSpec, type EvidenceObservation, type EvidenceEligibilityContext } from "@aistudy/domain";
import type { LearningSql } from "./opening-learning-facts";

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

function references(row: { sourceIds: readonly string[]; sourceVersions?: Record<string, number> | null; referenceSourceId?: string | null; referenceCheck?: { referenceId?: string | null } | null }): string[] {
  return [...new Set([...row.sourceIds, ...Object.keys(row.sourceVersions ?? {}),
    ...[row.referenceSourceId, row.referenceCheck?.referenceId].filter((id): id is string => Boolean(id))])].sort();
}

/** One bounded set of queries for the whole batch, including fixed-R historical heads. */
export async function readOpeningLearningEvidenceContexts(
  db: LearningSql, scope: Scope, records: readonly LearningObservation[],
): Promise<Record<string, OpeningEvidenceInput>> {
  if (!records.length) return {};
  const sessionIds = [...new Set(records.map(row => row.sessionId))];
  const attemptIds = [...new Set(records.flatMap(row => row.attemptId ? [row.attemptId] : []))];
  const problemIds = [...new Set(records.flatMap(row => row.problemId ? [row.problemId] : []))];
  const rootIds = [...new Set(records.map(row => row.rootObservationId ?? row.id))];
  const itemIds = [...new Set(records.flatMap(row => row.itemVersionId ? [row.itemVersionId] : []))];
  const sessions = await db`SELECT id,course_id FROM opening_learning_sessions
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND id =ANY(${sessionIds}::uuid[])`;
  const origins = new Map(sessions.map(row => [String(row.id), String(row.course_id)]));
  const courseIds = [...new Set(origins.values())];
  const help = courseIds.length ? await db`SELECT h.id,h.session_id,h.attempt_id,h.problem_id,h.level,h.kind,h.delivered,h.delivered_at,h.history_revision,l.course_id
    FROM opening_help_exposures h JOIN opening_learning_sessions l ON l.id=h.session_id AND l.workspace_id=h.workspace_id
    WHERE h.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND l.course_id =ANY(${courseIds}::uuid[])
      AND (${attemptIds.length ? db`h.attempt_id =ANY(${attemptIds}::uuid[])` : db`FALSE`}
        OR ${problemIds.length ? db`h.problem_id =ANY(${problemIds}::uuid[])` : db`FALSE`}
        OR (h.attempt_id IS NULL AND h.problem_id IS NULL AND h.session_id =ANY(${sessionIds}::uuid[])))
    ORDER BY h.created_at,h.id` : [];
  // Catalogue help is a retrievable receipt, not an invented assistant turn.
  // Keep the immutable exposure/protocol link even if the observation is revised.
  const examRows = courseIds.length && (attemptIds.length || problemIds.length) ? await db`SELECT e.id AS exam_link_id,
      e.learning_attempt_id AS attempt_id,e.first_family_exposure,e.delayed_earliest_at,e.submitted_answer,
      a.session_id,a.course_id,a.problem_id,a.item_version_id,
      s.pack_snapshot->>'id' AS exam_pack_id,s.pack_snapshot->>'version' AS exam_pack_version,
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
  const examHelp: Row[] = examRows.filter(row => row.receipt_id != null).map(row => ({
    id: `exam-help:${row.receipt_id}`, session_id: row.session_id, attempt_id: row.attempt_id,
    problem_id: row.problem_id, course_id: row.course_id,
    kind: row.kind === "solution" ? "solution" : "hint",
    level: row.kind === "solution" ? "revealed" : "hinted", delivered: true,
    delivered_at: row.delivered_at, history_revision: row.history_revision,
  }));
  const chain = await db`SELECT id,root_observation_id,revises_observation_id,answer,recorded_at,source_ids,source_versions,reference_source_id,reference_check
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
  const items = itemIds.length ? await db`SELECT v.id,p.problem_id,v.course_id,v.evaluation_spec FROM opening_learning_item_versions v
    LEFT JOIN opening_problem_refs p ON p.problem_id=v.problem_id AND p.workspace_id=v.workspace_id
      AND p.source_id=v.source_id AND p.source_version=v.source_version AND p.stem_snapshot=v.stem_snapshot
      AND p.chunk_id IS NOT DISTINCT FROM v.chunk_id AND p.physical_page IS NOT DISTINCT FROM v.physical_page AND p.artifact_kind=v.artifact_kind
    WHERE v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.id =ANY(${itemIds}::uuid[])` : [];
  const matchingItems = new Set(items.filter(row => row.problem_id != null).map(row => String(row.id)));
  const examItems = new Map(items.flatMap(row => {
    const spec = parseExamChoiceSpec(row.evaluation_spec);
    return spec ? [[String(row.id), spec] as const] : [];
  }));
  const catalogueItems = new Map(items.flatMap(row => {
    const spec = parseCanonicalMatrixExercise(row.evaluation_spec);
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
    const spec = parseCanonicalMatrixExercise(row.evaluation_spec);
    if (!spec) continue;
    const key = `${row.course_id}:${JSON.stringify(spec)}`;
    const entries = feedbackByCatalogue.get(key) ?? [];
    entries.push(row); feedbackByCatalogue.set(key, entries);
  }
  // Same-problem prior reference checks count as revealed answer exposure for later attempts.
  const priorReferenceHeads = problemIds.length ? await db`SELECT o.id, o.attempt_id, o.problem_id, o.item_version_id, o.verdict_source,
      o.submitted_at, o.recorded_at
    FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      AND COALESCE(root.effective_head_id,root.id)=o.id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND o.problem_id =ANY(${problemIds}::uuid[])
      AND o.verdict_source='reference_checked'
      AND o.attempt_id IS NOT NULL
      AND (o.revision_kind IS DISTINCT FROM 'retract')` : [];
  const priorsByProblem = new Map<string, Row[]>();
  for (const row of priorReferenceHeads) {
    const key = String(row.problem_id);
    const entries = priorsByProblem.get(key) ?? [];
    entries.push(row); priorsByProblem.set(key, entries);
  }
  const helpByAttempt = new Map<string, Row[]>(), helpByProblem = new Map<string, Row[]>(), legacyHelp = new Map<string, Row[]>();
  const add = (map: Map<string, Row[]>, key: string, row: Row) => { const entries = map.get(key) ?? []; entries.push(row); map.set(key, entries); };
  for (const row of [...help, ...examHelp]) {
    if (row.attempt_id) add(helpByAttempt, `${row.course_id}:${row.attempt_id}`, row);
    if (row.problem_id) add(helpByProblem, `${row.course_id}:${row.problem_id}`, row);
    if (row.attempt_id == null && row.problem_id == null) add(legacyHelp, String(row.session_id), row);
  }
  const result: Record<string, OpeningEvidenceInput> = {};
  for (const record of records) {
    const origin = origins.get(record.sessionId);
    const history = [...new Map([
      ...(record.attemptId ? helpByAttempt.get(`${origin}:${record.attemptId}`) ?? [] : []),
      ...(record.problemId ? helpByProblem.get(`${origin}:${record.problemId}`) ?? [] : []),
      ...(legacyHelp.get(record.sessionId) ?? []),
    ].map(row => [String(row.id), row])).values()];
    const startedMs = record.startedAt ? Date.parse(record.startedAt) : Number.NaN;
    if (record.problemId && Number.isFinite(startedMs)) {
      for (const prior of priorsByProblem.get(record.problemId) ?? []) {
        if (String(prior.id) === record.id) continue;
        if (record.attemptId && prior.attempt_id === record.attemptId) continue;
        if (record.itemVersionId && prior.item_version_id && String(prior.item_version_id) !== record.itemVersionId) continue;
        const checkedAt = prior.submitted_at ?? prior.recorded_at;
        const checkedMs = checkedAt ? new Date(checkedAt as string | Date).getTime() : Number.NaN;
        if (!Number.isFinite(checkedMs) || checkedMs >= startedMs) continue;
        history.push({
          id: `prior-reference:${prior.id}`,
          attempt_id: prior.attempt_id,
          problem_id: prior.problem_id,
          level: "revealed", kind: "solution",
          delivered: true,
          delivered_at: checkedAt,
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
      courseId: record.courseId, requirementKey: record.requirementKey ?? null,
      startedAt: record.startedAt ? Date.parse(record.startedAt) : null, submittedAt: record.submittedAt ? Date.parse(record.submittedAt) : null,
      assistance: record.assistance, outcome: record.outcome, verdictSource: record.verdictSource,
    };
    const context: EvidenceEligibilityContext = {
      serverEvaluation: serverEvaluationSchema.safeParse(record.serverEvaluation).data ?? null,
      helpHistory: { complete: Boolean(record.attemptId), exposures: history.map(row => ({
        attemptId: row.attempt_id as string | null, problemId: row.problem_id as string | null,
        level: row.level as "hinted" | "revealed",
        kind: (row.kind as "instruction" | "hint" | "solution" | "evaluation_feedback" | null | undefined) ?? "hint",
        ...(row.same_question === true ? { sameQuestion: true } : {}),
        delivered: row.delivered as boolean | null,
        deliveredAt: row.delivered_at ? new Date(row.delivered_at as string | Date).getTime() : null,
      })) }, referenceCheck: record.referenceCheck ?? null, version: { applicability: "version_unknown" }, delayedCheck: null,
    };
    const examSpec = record.itemVersionId ? examItems.get(record.itemVersionId) : undefined;
    const examLink = record.attemptId ? examLinks.get(record.attemptId) : undefined;
    const linkedExam = examSpec && examLink && examLink.session_id === record.sessionId
      && examLink.problem_id === record.problemId && examLink.item_version_id === record.itemVersionId
      && examLink.exam_pack_id === examSpec.packId && examLink.exam_pack_version === examSpec.packVersion
      && typeof examLink.first_family_exposure === "boolean";
    if (linkedExam) {
      context.examAttempt = {
        firstFamilyExposure: examLink.first_family_exposure as boolean,
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
    const itemMatches = Boolean(record.itemVersionId && matchingItems.has(record.itemVersionId));
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
