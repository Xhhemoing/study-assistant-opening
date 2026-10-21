import { getSpanReservedProblem } from "@aistudy/domain/span-heldout-catalog";
import { parseOpeningSpanExercise, parseOpeningSpanIntent, readOpeningSpanExposureHistory } from "./opening-span-attempt";
import { resolveOpeningStudyContext } from "./opening-study-context";
import { captureOpeningLearnerShadowPredictions } from "./opening-learner-shadow-predictions";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import type { LearningAttempt, LearningAttemptCreateInput, Scope, StudyContextAnchor } from "@aistudy/contracts";
import { SPAN_SKILL_LABEL, SPAN_REQUIREMENT_KEY, assertRetestSubmitEarliestAllowed, getSpanProblem, spanProblemStem, createMatrixExerciseSpec, matrixExerciseRequirement, matrixExerciseSkillLabel, matrixExerciseStem, parseCanonicalMatrixExercise } from "@aistudy/domain";
import { admitLearningSources, learningError, learningIso, lockLearningHistory, lockWorkspaceLearningHistory, lockLearningOwner, lockLearningSession, nextLearningHistoryRevision } from "./opening-learning-facts";

export { readOpeningSpanExposureHistory } from "./opening-span-attempt";

export function mapLearningAttempt(row: Record<string, unknown>): LearningAttempt {
  const matrixExercise = parseCanonicalMatrixExercise(row.evaluation_spec);
  const canonicalSpan = parseOpeningSpanExercise(row.evaluation_spec);
  const restored = canonicalSpan ? null : parseOpeningSpanIntent(row.create_intent);
  const spanExercise = canonicalSpan ?? (restored && row.item_stem_snapshot === spanProblemStem(restored.problem)
    && row.item_source_id === restored.sourceId && (row.source_ids as string[]).includes(restored.sourceId) ? restored.problem : null);
  const spanValidation = !canonicalSpan && (restored || row.requirement_key === SPAN_REQUIREMENT_KEY)
    ? { eligible: false, firstFamilyExposure: false, reasonCode: spanExercise ? "restored_identity_unverified" : "restored_identity_unavailable" }
    : (row.create_intent as { spanValidation?: LearningAttempt["spanValidation"] } | undefined)?.spanValidation;
  return { id: String(row.id), workspaceId: String(row.workspace_id), sessionId: String(row.session_id), courseId: String(row.course_id),
    skillLabel: String(row.skill_label), requirementKey: row.requirement_key as string | null, problemId: row.problem_id as string | null,
    itemVersionId: row.item_version_id as string | null, sourceIds: row.source_ids as string[], sourceVersions: row.source_versions as Record<string, number>,
    startedAt: learningIso(row.started_at)!, submittedAt: learningIso(row.submitted_at), observationId: row.observation_id as string | null,
    historyRevision: Number(row.history_revision), ...(matrixExercise ? { matrixExercise } : {}), ...(spanExercise ? { spanExercise } : {}),
    ...(row.context_anchor ? { contextAnchor: row.context_anchor as StudyContextAnchor } : {}),
    ...(spanValidation ? { spanValidation } : {}) };
}

/** Canonical attempt creation, also used by the atomic held-out issuer. Caller owns the transaction. */
export async function createOpeningLearningAttemptInTx(tx: TransactionSql, scope: Scope, input: LearningAttemptCreateInput): Promise<LearningAttempt> {
  await lockWorkspaceLearningHistory(tx, scope);
  const session = await lockLearningSession(tx, scope, input.sessionId);
  const courseId = String(session.course_id);
  await lockLearningHistory(tx, scope, courseId);
  const sources = await admitLearningSources(tx, scope, session.source_ids as string[]);
  const sourceVersions = Object.fromEntries(sources.map((s) => [String(s.id), Number(s.version)]));
  let requirementKey = input.requirementKey ?? null;
  const spanExercise = input.spanExercise ? (getSpanProblem(input.spanExercise.problemId, input.spanExercise.version) ?? getSpanReservedProblem(input.spanExercise.problemId, input.spanExercise.version)) : null;
  const spanSpec = spanExercise ? { kind: "span", specVersion: "span-v1", problemId: spanExercise.id, version: Number(spanExercise.version), familyId: spanExercise.familyId, requirementKey: SPAN_REQUIREMENT_KEY, knowledgeComponents: spanExercise.knowledgeComponents, transfer: spanExercise.transfer ?? null } : null;
  if (input.spanExercise) {
    if (!spanExercise) throw learningError("VALIDATION", "span question version unavailable");
    if (!(session.source_ids as string[]).includes(input.spanExercise.sourceId)) throw learningError("VALIDATION", "span exercise source is outside session");
    if (session.skill_label !== SPAN_SKILL_LABEL) throw learningError("VALIDATION", "span exercise does not match session skill");
    requirementKey = SPAN_REQUIREMENT_KEY;
  }
  let matrixExercise = input.matrixExercise ? createMatrixExerciseSpec(input.matrixExercise.exerciseKey, input.matrixExercise.variant) : null;
  if (input.matrixExercise) {
    if (!(session.source_ids as string[]).includes(input.matrixExercise.sourceId)) throw learningError("VALIDATION", "matrix exercise source is outside session");
    if (session.skill_label !== matrixExerciseSkillLabel(input.matrixExercise.exerciseKey)) throw learningError("VALIDATION", "matrix exercise does not match session skill");
    requirementKey = matrixExerciseRequirement(matrixExercise!);
  }
  let referencedProblemVersionKnown = !input.teachingBlock;
  if (input.teachingBlock) {
    if (input.requirementKey) throw learningError("VALIDATION", "teaching block sets its own requirement key");
    const specs = await tx`SELECT s.block_order, s.source_refs, s.version, a.content_version, a.status FROM opening_teaching_activity_specs s
      JOIN opening_teaching_activities a ON a.id=s.activity_id AND a.workspace_id=s.workspace_id AND a.owner_user_id=s.owner_user_id
      WHERE s.activity_id=${String(session.activity_id)} AND s.workspace_id=${scope.workspaceId} AND s.owner_user_id=${scope.ownerUserId} FOR SHARE OF a,s`;
    const spec = specs[0];
    if (!spec || Number(spec.content_version) !== input.teachingBlock.contentVersion || Number(spec.version) !== input.teachingBlock.contentVersion) throw learningError("CONFLICT", "teaching content changed; reread before answering");
    if (spec.status === "completed") throw learningError("CONFLICT", "completed teaching activity cannot accept new attempts");
    const refs = spec.block_order as Array<{ blockId: string; blockType: string; role: string }>;
    const ref = refs.find((block) => block.blockId === input.teachingBlock!.blockId);
    if (!ref || ref.role === "answer_key" || !["prompt", "question"].includes(ref.blockType) && ref.role !== "prompt") throw learningError("VALIDATION", "teaching question not found");
    const references = spec.source_refs as Array<{ sourceId: string; version?: string | number | null }>;
    for (const source of references) {
      const version = source.version == null ? NaN : Number(source.version);
      if (Number.isInteger(version) && sourceVersions[source.sourceId] !== version) throw learningError("CONFLICT", "teaching reference material version changed; reread the teaching content");
    }
    referencedProblemVersionKnown = references.some((source) => source.sourceId === input.problem?.sourceId && source.version != null && Number.isInteger(Number(source.version)));
    requirementKey = `teaching:${input.teachingBlock.blockId}:v${input.teachingBlock.contentVersion}`;
  }
  const intent = { sessionId: input.sessionId, problemId: input.problemId ?? null, problem: input.problem ?? null, requirementKey,
    ...(input.teachingBlock ? { teachingBlock: input.teachingBlock } : {}), ...(input.matrixExercise ? { matrixExercise: input.matrixExercise } : {}),
    ...(input.spanExercise ? { spanExercise: input.spanExercise } : {}), ...(input.contextAnchor ? { contextAnchor: input.contextAnchor } : {}) };
  const replay = await tx`SELECT a.*,v.evaluation_spec,v.stem_snapshot AS item_stem_snapshot,v.source_id AS item_source_id FROM opening_learning_attempts a
    LEFT JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
    WHERE a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND a.client_key=${input.clientKey}`;
  if (replay[0]) {
    const replayIntent = { ...replay[0].create_intent as Record<string, unknown> };
    delete replayIntent.spanValidation;
    if (!isDeepStrictEqual(replayIntent, intent)) throw learningError("CONFLICT", "attempt clientKey payload conflict");
    return mapLearningAttempt(replay[0]);
  }
  // An acknowledged attempt remains replayable after pause/completion, but a
  // dedicated span lesson must be resumed before it can issue another question.
  const spanActivities = await tx`SELECT status,checkpoint_json FROM opening_teaching_activities
    WHERE id=${String(session.activity_id)} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND create_intent->>'protocol'='span-lesson-v1' FOR SHARE`;
  if (spanActivities[0] && spanActivities[0].status !== "active") {
    throw learningError("CONFLICT", "paused or completed span lesson cannot accept new attempts");
  }
  const spanRetestId = (spanActivities[0]?.checkpoint_json as { spanLesson?: { retestId?: string | null } } | undefined)?.spanLesson?.retestId;
  if (spanRetestId) {
    // Binding and timing come from the persisted lesson, so callers cannot skip
    // preparation or omit a retestId to issue the reserved question early.
    const retests = await tx`SELECT not_before_at,recommended_at,scheduled_start_at FROM opening_retest_activities
      WHERE (id=${spanRetestId} OR candidate_id=${spanRetestId} OR candidate_reference_id=${spanRetestId}) AND workspace_id=${scope.workspaceId}
        AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId} AND requirement_key=${SPAN_REQUIREMENT_KEY}
        AND skill_label=${SPAN_SKILL_LABEL} AND status IN ('accepted','in_progress') FOR SHARE`;
    if (retests.length !== 1) throw learningError("VALIDATION", "延迟复测不属于本课程、尚未接受或已结束。");
    const retest = retests[0]!, [clock] = await tx`SELECT clock_timestamp() AS at`;
    assertRetestSubmitEarliestAllowed({ notBeforeAt: learningIso(retest.not_before_at), recommendedAt: learningIso(retest.recommended_at),
      scheduledStartAt: learningIso(retest.scheduled_start_at) }, learningIso(clock!.at)!);
  }
  let spanValidation: LearningAttempt["spanValidation"];
  if (spanExercise) {
    const history = await readOpeningSpanExposureHistory(tx, scope);
    const previous = history.familyIds.has(spanExercise.familyId) || history.unknownHistory;
    spanValidation = { eligible: !previous, firstFamilyExposure: !previous,
      reasonCode: history.unknownHistory ? "prior_span_identity_unknown" : previous ? "family_previously_issued" : null };
  }
  const savedIntent = { ...intent, ...(spanValidation ? { spanValidation } : {}) };
  let problemId = input.problemId ?? null, itemVersionId: string | null = null;
  let problem = input.problem;
  if (input.spanExercise && spanExercise && spanSpec) {
    const existing = await tx`SELECT problem_id FROM opening_learning_item_versions
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
        AND source_id=${input.spanExercise.sourceId} AND source_version=${sourceVersions[input.spanExercise.sourceId]!}
        AND evaluation_spec=${tx.json(spanSpec)} ORDER BY created_at,id LIMIT 1`;
    problemId = existing[0] ? String(existing[0].problem_id) : null;
    if (!problemId) problem = { sourceId: input.spanExercise.sourceId, stemSnapshot: spanProblemStem(spanExercise), artifactKind: "unknown" };
  }
  if (input.matrixExercise && matrixExercise) {
    // Reopening the same catalogue question reuses its identity across sessions.
    // The course history lock serializes concurrent starts, including first creation.
    const existing = await tx`SELECT problem_id FROM opening_learning_item_versions
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
        AND source_id=${input.matrixExercise.sourceId} AND source_version=${sourceVersions[input.matrixExercise.sourceId]!}
        AND evaluation_spec=${tx.json(matrixExercise)} ORDER BY created_at,id LIMIT 1`;
    problemId = existing[0] ? String(existing[0].problem_id) : null;
    if (!problemId) problem = { sourceId: input.matrixExercise.sourceId, stemSnapshot: matrixExerciseStem(matrixExercise), artifactKind: "unknown" };
  }
  if (problem) {
    if (!(session.source_ids as string[]).includes(problem.sourceId)) throw learningError("VALIDATION", "problem source is outside session");
    if (problem.chunkId) {
      const chunks = await tx`SELECT id FROM opening_source_chunks WHERE id=${problem.chunkId} AND source_id=${problem.sourceId}
        AND source_version=${sourceVersions[problem.sourceId]!} AND (${problem.physicalPage ?? null}::int IS NULL OR page=${problem.physicalPage ?? null})`;
      if (!chunks.length) throw learningError("VALIDATION", "problem chunk does not match captured source");
    }
    problemId = randomUUID();
    await tx`INSERT INTO opening_problem_refs(problem_id,workspace_id,session_id,source_id,source_version,physical_page,chunk_id,stem_snapshot,artifact_kind)
      VALUES (${problemId},${scope.workspaceId},${input.sessionId},${problem.sourceId},${sourceVersions[problem.sourceId]!},${problem.physicalPage ?? null},${problem.chunkId ?? null},${problem.stemSnapshot},${referencedProblemVersionKnown ? problem.artifactKind : "unknown"})`;
  }
  if (problemId) {
    const examItems = await tx`SELECT id FROM opening_learning_item_versions
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND problem_id=${problemId} AND evaluation_spec->>'kind'='exam_choice' LIMIT 1`;
    if (examItems.length) throw learningError("CONFLICT", "冲刺题目只能在冲刺入口创建作答，不能复制为普通练习");
    const refs = await tx`SELECT p.* FROM opening_problem_refs p JOIN opening_learning_sessions l ON l.id=p.session_id
      WHERE p.problem_id=${problemId} AND p.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND l.course_id=${courseId} FOR SHARE OF p`;
    const ref = refs[0];
    if (!ref || !(session.source_ids as string[]).includes(String(ref.source_id))) throw learningError("VALIDATION", "problem is outside the session course or sources");
    sourceVersions[String(ref.source_id)] = Number(ref.source_version);
    const versions = await tx`SELECT id,evaluation_spec FROM opening_learning_item_versions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND problem_id=${problemId} AND source_id=${ref.source_id} AND source_version=${ref.source_version}
      AND stem_snapshot=${ref.stem_snapshot} AND artifact_kind=${ref.artifact_kind}
      AND chunk_id IS NOT DISTINCT FROM ${ref.chunk_id} AND physical_page IS NOT DISTINCT FROM ${ref.physical_page} ORDER BY created_at LIMIT 1`;
    itemVersionId = versions[0] ? String(versions[0].id) : randomUUID();
    if (versions[0]) matrixExercise = parseCanonicalMatrixExercise(versions[0].evaluation_spec);
    if (matrixExercise) {
      if (session.skill_label !== matrixExerciseSkillLabel(matrixExercise.exerciseKey)) throw learningError("VALIDATION", "matrix exercise does not match session skill");
      requirementKey = matrixExerciseRequirement(matrixExercise);
    }
    if (!versions.length) await tx`INSERT INTO opening_learning_item_versions(id,workspace_id,owner_user_id,course_id,activity_id,problem_id,source_id,source_version,physical_page,chunk_id,stem_snapshot,artifact_kind,evaluation_spec)
      VALUES (${itemVersionId},${scope.workspaceId},${scope.ownerUserId},${courseId},${String(session.activity_id)},${problemId},${ref.source_id},${ref.source_version},${ref.physical_page},${ref.chunk_id},${ref.stem_snapshot},${ref.artifact_kind},${spanSpec ? tx.json(spanSpec) : matrixExercise ? tx.json(matrixExercise) : null})`;
  }
  const contextAnchor = input.contextAnchor ? await resolveOpeningStudyContext(tx, scope, input.contextAnchor, {
    courseId, sessionId: input.sessionId, sourceIds: session.source_ids as string[],
  }) : undefined;
  if (contextAnchor?.itemVersionId && contextAnchor.itemVersionId !== itemVersionId) throw learningError("CONFLICT", "attempt item does not match context");
  if (contextAnchor?.attemptId) throw learningError("VALIDATION", "a new attempt cannot inherit another attempt anchor");
  const revision = await nextLearningHistoryRevision(tx, scope, courseId);
  const rows = await tx`INSERT INTO opening_learning_attempts(id,workspace_id,owner_user_id,session_id,course_id,activity_id,skill_label,requirement_key,problem_id,item_version_id,source_ids,source_versions,client_key,create_intent,history_revision,context_anchor)
    VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},${input.sessionId},${courseId},${String(session.activity_id)},${session.skill_label},${requirementKey},${problemId},${itemVersionId},${session.source_ids},${tx.json(sourceVersions)},${input.clientKey},${tx.json(savedIntent as never)},${revision},${contextAnchor ? tx.json(contextAnchor) : null})
    ON CONFLICT (workspace_id,owner_user_id,client_key) DO NOTHING RETURNING *`;
  if (!rows[0]) throw learningError("CONFLICT", "attempt clientKey already used");
  const savedAnchor = await resolveOpeningStudyContext(tx, scope, { ...(input.contextAnchor ?? { purpose: "learning_help" as const }), attemptId: String(rows[0].id) }, {
    courseId, sessionId: input.sessionId, sourceIds: session.source_ids as string[],
  });
  await tx`UPDATE opening_learning_attempts SET context_anchor=${tx.json(savedAnchor)} WHERE id=${String(rows[0].id)}`;
  await captureOpeningLearnerShadowPredictions(tx, scope, String(rows[0].id));
  return mapLearningAttempt({ ...rows[0], context_anchor: savedAnchor, evaluation_spec: spanSpec ?? matrixExercise });

}

export function createOpeningLearningAttemptRepository(sql: Sql) {
  return {
    async get(scope: Scope, id: string): Promise<LearningAttempt | null> {
      const rows = await sql`SELECT a.*,v.evaluation_spec,v.stem_snapshot AS item_stem_snapshot,v.source_id AS item_source_id FROM opening_learning_attempts a JOIN workspaces w ON w.id=a.workspace_id
        LEFT JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
        WHERE a.id=${id} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId} AND w.owner_user_id=${scope.ownerUserId}`;
      return rows[0] ? mapLearningAttempt(rows[0]) : null;
    },
    async create(scope: Scope, input: LearningAttemptCreateInput): Promise<LearningAttempt> {
      return sql.begin(tx => createOpeningLearningAttemptInTx(tx, scope, input)) as Promise<LearningAttempt>;
    },

    /** Activity-scoped attempts with optional observation outcome for resume (V2-14). */
    async listByActivity(
      scope: Scope,
      activityId: string,
      limit = 100,
    ): Promise<
      Array<
        LearningAttempt & {
          outcome: string | null;
          assistance: string | null;
        }
      >
    > {
      const capped = Math.min(Math.max(1, limit), 100);
      const rows = await sql`
        SELECT a.*, v.evaluation_spec,v.stem_snapshot AS item_stem_snapshot,v.source_id AS item_source_id,
          o.outcome AS obs_outcome,
          o.assistance AS obs_assistance
        FROM opening_learning_attempts a
        JOIN workspaces w ON w.id = a.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
        LEFT JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
        LEFT JOIN opening_learning_observations o
          ON o.id = a.observation_id
          AND o.workspace_id = a.workspace_id
          AND o.owner_user_id = a.owner_user_id
        WHERE a.workspace_id = ${scope.workspaceId}
          AND a.owner_user_id = ${scope.ownerUserId}
          AND a.activity_id = ${activityId}
        ORDER BY a.started_at DESC, a.id
        LIMIT ${capped}`;
      return rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          ...mapLearningAttempt(r),
          outcome: (r.obs_outcome ?? null) as string | null,
          assistance: (r.obs_assistance ?? null) as string | null,
        };
      });
    },

    async assertAccess(scope: Scope, id: string) {
      return sql.begin(async (tx) => {
        await lockLearningOwner(tx, scope);
        const rows = await tx`SELECT a.*,v.evaluation_spec,v.stem_snapshot AS item_stem_snapshot,v.source_id AS item_source_id FROM opening_learning_attempts a
          LEFT JOIN opening_learning_item_versions v ON v.id=a.item_version_id AND v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id
          WHERE a.id=${id} AND a.workspace_id=${scope.workspaceId} AND a.owner_user_id=${scope.ownerUserId}`;
        if (!rows[0]) throw learningError("NOT_FOUND", "attempt not found");
        await admitLearningSources(tx, scope, rows[0].source_ids as string[]);
        return mapLearningAttempt(rows[0]);
      });
    },
  };
}
