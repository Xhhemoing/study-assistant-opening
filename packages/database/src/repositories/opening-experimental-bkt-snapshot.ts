import type { Scope } from "@aistudy/contracts";
import type { LearnerStateFeature, SnapshotObservation } from "@aistudy/domain";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { parseOpeningSpanExercise } from "./opening-span-attempt";

/** Frozen UI port c20d/ac992259ff56c9d0e7ecfda0766ab46ddf495cc9.
 * No import/call of aa8c wrapper (its duplicate-head R3 is outside this adapter).
 * Metadata only: no answer, source body, evaluation payload or projection repair.
 * Current effective heads at one DB snapshot, NOT historical head reconstruction.
 */
export type ExperimentalBktSnapshotInput = {
  courseId: string; requirementKey: string; problemId: string; itemVersionId: string;
  cutoff: string; excludedProblemIds?: readonly string[];
};
export type ExperimentalBktSnapshot = {
  scope: Scope & { courseId: string }; dataAsOf: string | null; stateVersion: string | null;
  cutoff: string; features: LearnerStateFeature[]; observationHeads: SnapshotObservation[];
  /** Canonical catalogue provenance, never a source ID or a per-KC expansion. */
  families: Array<{ observationId: string; familyId: string; provenance: "span_catalogue" }>;
  excluded: Record<string, number>;
} & ({ status: "available"; reason: null } | { status: "not_available"; reason: string });

type Row = Record<string, unknown>;
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function time(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const parsed = Date.parse(value), day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10)
    && Number(value.slice(11, 13)) < 24 ? parsed : NaN;
}
function revision(value: unknown): string | null {
  return (typeof value === "string" || typeof value === "number") && /^(0|[1-9]\d*)$/.test(String(value))
    && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER) ? String(value) : null;
}
function canonicalFamily(row: Row, requirementKey: string): string | null {
  // Project only these spec metadata keys in SQL; no operands, prompt or answer.
  const spec = row.spec_metadata;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const value = spec as Row, problem = parseOpeningSpanExercise(value);
  return problem && text(value.familyId) && value.familyId === problem.familyId
    && value.requirementKey === requirementKey ? problem.familyId : null;
}

function validHeldOutIds(value: ExperimentalBktSnapshotInput["excludedProblemIds"]): boolean {
  return value === undefined || Array.isArray(value) && value.every(uuid);
}

/** IDs are resolved from scoped DB metadata, never caller-supplied family claims.
 * No effective-head or current-requirement filter: old observations and other
 * requirements still carry held-out identity. Every binding must be provable;
 * absent, stale, conflicting or unsupported bindings fail the entire request.
 */
function resolveHeldOutFamilies(scope: Scope, input: ExperimentalBktSnapshotInput, rows: readonly Row[], asOf: number): Set<string> | null {
  const families = new Set<string>();
  for (const heldOutId of new Set(input.excludedProblemIds ?? [])) {
    const bindings = rows.filter(row => row.held_out_id === heldOutId);
    if (!bindings.length) return null;
    const resolved = new Set<string>();
    for (const row of bindings) {
      if (row.workspace_id !== scope.workspaceId || row.owner_user_id !== scope.ownerUserId || row.course_id !== input.courseId
        || !uuid(row.item_version_id) || !uuid(row.problem_id) || row.resolver_current !== true
        || !text(row.requirement_key) || !Number.isFinite(time(row.item_created_at)) || time(row.item_created_at) > asOf) return null;
      const family = canonicalFamily(row, row.requirement_key);
      if (!family) return null;
      resolved.add(family);
    }
    if (resolved.size !== 1) return null;
    families.add([...resolved][0]!);
  }
  return families;
}

/** Metadata-only lookup inside the owning read transaction, including observations
 * that are revised/retracted/not effective and problems outside this requirement.
 * The problem and item binding are scoped again after the UNION. No raw family
 * input or body/answer is accepted. Missing rows remain unavailable, never ignored.
 */
export function openingExperimentalBktHeldOutQuery(tx: TransactionSql, scope: Scope, input: ExperimentalBktSnapshotInput) {
  return tx`WITH bindings AS (
      SELECT v.problem_id AS held_out_id,v.id AS item_version_id,v.problem_id,
        v.evaluation_spec->>'requirementKey' AS requirement_key
      FROM opening_learning_item_versions v WHERE v.workspace_id=${scope.workspaceId}
        AND v.owner_user_id=${scope.ownerUserId} AND v.course_id=${input.courseId}
        AND v.problem_id=ANY(${[...new Set(input.excludedProblemIds ?? [])]}::uuid[])
      UNION ALL
      SELECT o.id AS held_out_id,o.item_version_id,o.problem_id,o.requirement_key
      FROM opening_learning_observations o WHERE o.workspace_id=${scope.workspaceId}
        AND o.owner_user_id=${scope.ownerUserId} AND o.course_id=${input.courseId}
        AND o.id=ANY(${[...new Set(input.excludedProblemIds ?? [])]}::uuid[])
    ) SELECT b.held_out_id,b.requirement_key,v.id AS item_version_id,v.problem_id,
      v.workspace_id,v.owner_user_id,v.course_id,v.created_at AS item_created_at,
      (EXISTS (SELECT 1 FROM opening_problem_refs r WHERE r.problem_id=v.problem_id AND r.workspace_id=v.workspace_id
          AND r.source_id IS NOT DISTINCT FROM v.source_id AND r.source_version IS NOT DISTINCT FROM v.source_version
          AND r.stem_snapshot=v.stem_snapshot AND r.artifact_kind=v.artifact_kind
          AND r.physical_page IS NOT DISTINCT FROM v.physical_page AND r.chunk_id IS NOT DISTINCT FROM v.chunk_id
          AND r.teaching_revision_id IS NOT DISTINCT FROM v.teaching_revision_id
          AND r.teaching_block_id IS NOT DISTINCT FROM v.teaching_block_id)
        AND (v.source_id IS NULL OR EXISTS (SELECT 1 FROM opening_sources s WHERE s.id=v.source_id
          AND s.workspace_id=v.workspace_id AND s.version=v.source_version AND s.upload_state='uploaded'
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
          AND NOT EXISTS (SELECT 1 FROM opening_source_versions sv WHERE sv.workspace_id=s.workspace_id
            AND sv.source_id=s.id AND sv.version=s.version AND sv.availability='unavailable')))) AS resolver_current,
      jsonb_build_object('kind',v.evaluation_spec->'kind','specVersion',v.evaluation_spec->'specVersion',
        'problemId',v.evaluation_spec->'problemId','version',v.evaluation_spec->'version',
        'familyId',v.evaluation_spec->'familyId','requirementKey',v.evaluation_spec->'requirementKey') AS spec_metadata
    FROM bindings b LEFT JOIN opening_learning_item_versions v ON v.id=b.item_version_id AND v.problem_id=b.problem_id
      AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.course_id=${input.courseId}`;
}

/** Actual parameterized postgres.js query. Caller must own the read-only snapshot.
 * Strong conservative admission: original heads, exact same global revision as the
 * persisted qualification, live version/privacy/item checks, and no course help.
 * A changed revision is unavailable; this reader never refreshes stale projections.
 */
export function openingExperimentalBktHeadsQuery(tx: TransactionSql, scope: Scope, input: ExperimentalBktSnapshotInput) {
  return tx`SELECT o.id,o.workspace_id,o.owner_user_id,o.course_id,o.requirement_key,o.skill_label,
      o.problem_id,o.item_version_id,o.attempt_id,o.submitted_at,o.recorded_at,o.outcome,o.assistance,o.verdict_source,
      o.source_ids,o.source_versions,a.started_at AS attempt_started_at,v.created_at AS item_created_at,
      o.revision_kind,o.root_observation_id,o.revises_observation_id,o.workspace_history_revision,
      COALESCE(root.effective_head_id,root.id) AS effective_head_id,
      a.problem_id AS attempt_problem_id,a.item_version_id AS attempt_item_version_id,
      a.requirement_key AS attempt_requirement_key,a.submitted_at AS attempt_submitted_at,
      a.observation_id AS attempt_observation_id,v.problem_id AS item_problem_id,
      p.head_observation_id,p.head_revision,p.input_revision,p.policy_version,
      p.independent_attempt,p.verified_correct,p.usable_for_current_version,p.reason_codes,p.version_applicability,
      p.item_matches,
      jsonb_build_object('kind',v.evaluation_spec->'kind','specVersion',v.evaluation_spec->'specVersion',
        'problemId',v.evaluation_spec->'problemId','version',v.evaluation_spec->'version',
        'familyId',v.evaluation_spec->'familyId','requirementKey',v.evaluation_spec->'requirementKey') AS spec_metadata,
      (p.source_states=COALESCE(live.states,'[]'::jsonb) AND NOT EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=o.workspace_id
          AND e.source_id::text=ANY(p.privacy_source_ids))) AS sources_current,
      EXISTS (SELECT 1 FROM opening_problem_refs r WHERE r.problem_id=v.problem_id AND r.workspace_id=v.workspace_id
        AND r.source_id IS NOT DISTINCT FROM v.source_id AND r.source_version IS NOT DISTINCT FROM v.source_version
        AND r.stem_snapshot=v.stem_snapshot AND r.artifact_kind=v.artifact_kind
        AND r.physical_page IS NOT DISTINCT FROM v.physical_page AND r.chunk_id IS NOT DISTINCT FROM v.chunk_id
        AND r.teaching_revision_id IS NOT DISTINCT FROM v.teaching_revision_id
        AND r.teaching_block_id IS NOT DISTINCT FROM v.teaching_block_id) AS item_current,
      EXISTS (SELECT 1 FROM opening_help_exposures h LEFT JOIN opening_learning_sessions hs
          ON hs.id=h.session_id AND hs.workspace_id=h.workspace_id
        WHERE h.workspace_id=o.workspace_id AND COALESCE(h.owner_user_id,hs.owner_user_id)=o.owner_user_id
          AND h.delivered=TRUE AND (COALESCE(h.course_id,hs.course_id)=o.course_id
            OR (h.course_id IS NULL AND h.session_id IS NULL))) AS has_course_help,
      EXISTS (SELECT 1 FROM opening_study_intent_events e WHERE e.workspace_id=o.workspace_id
        AND e.owner_user_id=o.owner_user_id AND e.attempt_id=o.attempt_id
        AND (e.payload->'signals' ? 'copied_answer' OR e.payload->'signals' ? 'guessed')) AS answer_conditions,
      EXISTS (SELECT 1 FROM opening_learning_observations other
        LEFT JOIN opening_learning_item_versions ov ON ov.id=other.item_version_id AND ov.workspace_id=other.workspace_id
          AND ov.owner_user_id=other.owner_user_id
        WHERE other.workspace_id=o.workspace_id AND other.owner_user_id=o.owner_user_id AND other.id<>o.id
          AND (other.attempt_id=o.attempt_id OR other.problem_id=o.problem_id
            OR (ov.evaluation_spec->>'kind'=v.evaluation_spec->>'kind'
              AND ov.evaluation_spec->>'problemId'=v.evaluation_spec->>'problemId'
              AND ov.evaluation_spec->>'version'=v.evaluation_spec->>'version'))) AS has_conflicting_history,
      (o.ai_evaluation IS NOT NULL OR COALESCE(o.submitted_intent ? 'aiGrading',FALSE)) AS has_ai
    FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id AND root.course_id=o.course_id
      AND COALESCE(root.effective_head_id,root.id)=o.id
    JOIN opening_learning_attempts a ON a.id=o.attempt_id AND a.workspace_id=o.workspace_id
      AND a.owner_user_id=o.owner_user_id AND a.course_id=o.course_id AND a.session_id=o.session_id
    JOIN opening_learning_item_versions v ON v.id=o.item_version_id AND v.workspace_id=o.workspace_id
      AND v.owner_user_id=o.owner_user_id AND v.course_id=o.course_id
    LEFT JOIN opening_learning_eligibility p ON p.workspace_id=o.workspace_id AND p.owner_user_id=o.owner_user_id
      AND p.root_observation_id=root.id
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('sourceId',ids.source_id,'version',s.version,
        'uploaded',COALESCE(s.upload_state='uploaded',FALSE),'historicalUnavailable',EXISTS(
          SELECT 1 FROM opening_source_versions sv WHERE sv.workspace_id=o.workspace_id
            AND sv.source_id::text=ids.source_id AND sv.version::text=o.source_versions->>ids.source_id
            AND sv.availability='unavailable')) ORDER BY ids.source_id COLLATE "C") AS states
      FROM (SELECT unnest(o.source_ids)::text AS source_id UNION SELECT jsonb_object_keys(COALESCE(o.source_versions,'{}'::jsonb))
        UNION SELECT o.reference_source_id::text UNION SELECT o.reference_check->>'referenceId') ids
      LEFT JOIN opening_sources s ON s.workspace_id=o.workspace_id AND s.id::text=ids.source_id
      WHERE ids.source_id IS NOT NULL AND ids.source_id<>'') live ON TRUE
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND o.course_id=${input.courseId} AND o.requirement_key=${input.requirementKey}
    ORDER BY o.submitted_at,o.recorded_at,o.id`;
}

/** Validate unstructured DB results before pairing features/heads. Duplicate or
 * conflicting identity poisons ALL copies, never last-write-wins in a Map.
 */
export function projectOpeningExperimentalBktSnapshot(scope: Scope, input: ExperimentalBktSnapshotInput,
  context: Row, target: Row | undefined, rows: readonly Row[], heldOutRows: readonly Row[] = []): ExperimentalBktSnapshot {
  const result = { scope: { ...scope, courseId: input.courseId }, cutoff: input.cutoff,
    dataAsOf: null as string | null, stateVersion: null as string | null,
    features: [] as LearnerStateFeature[], observationHeads: [] as SnapshotObservation[],
    families: [] as ExperimentalBktSnapshot["families"], excluded: {} as Record<string, number> };
  const unavailable = (reason: string): ExperimentalBktSnapshot => ({ ...result, status: "not_available", reason });
  const cutoff = time(input.cutoff), asOf = time(context.data_as_of), rev = revision(context.revision);
  if (![scope.workspaceId, scope.ownerUserId, input.courseId, input.problemId, input.itemVersionId].every(uuid)
    || !text(input.requirementKey) || !Number.isFinite(cutoff)
    || !validHeldOutIds(input.excludedProblemIds)) return unavailable("invalid_input");
  if (context.workspace_id !== scope.workspaceId || context.owner_user_id !== scope.ownerUserId || context.course_id !== input.courseId
    || !Number.isFinite(asOf) || cutoff > asOf || rev === null || !text(context.snapshot_token)) return unavailable("snapshot_unavailable");
  result.dataAsOf = new Date(asOf).toISOString();
  // A read identity, not a reusable decision receipt or a claim of historical state.
  result.stateVersion = `bkt-read:${context.snapshot_token}:${rev}:${result.dataAsOf}`;
  const targetFamily = target && target.workspace_id === scope.workspaceId && target.owner_user_id === scope.ownerUserId
    && target.course_id === input.courseId && target.id === input.itemVersionId && target.problem_id === input.problemId
    && target.target_current === true && Number.isFinite(time(target.target_created_at)) && time(target.target_created_at) <= cutoff
    ? canonicalFamily(target, input.requirementKey) : null;
  if (!targetFamily) return unavailable("canonical_target_family_unavailable");
  const heldOutFamilies = resolveHeldOutFamilies(scope, input, heldOutRows, asOf);
  if (!heldOutFamilies) return unavailable("held_out_family_unavailable");
  const counts = (key: string) => {
    const map = new Map<unknown, number>();
    for (const row of rows) map.set(row[key], (map.get(row[key]) ?? 0) + 1);
    return map;
  };
  const ids = counts("id"), attempts = counts("attempt_id"), problems = counts("problem_id");
  const catalogueKey = (row: Row) => {
    const metadata = row.spec_metadata as Row | null;
    return metadata ? JSON.stringify([metadata.kind, metadata.problemId, String(metadata.version)]) : null;
  };
  const catalogueCounts = new Map<string | null, number>();
  for (const row of rows) { const key = catalogueKey(row); catalogueCounts.set(key, (catalogueCounts.get(key) ?? 0) + 1); }
  const excluded = new Set(input.excludedProblemIds ?? []);
  const policyVersion = evaluateEvidenceEligibility({}, {}).policyVersion;
  for (const row of [...rows].sort((a, b) => time(a.submitted_at) - time(b.submitted_at) || String(a.id).localeCompare(String(b.id)))) {
    let reason: string | null = null;
    const family = canonicalFamily(row, input.requirementKey), attempted = time(row.submitted_at), recorded = time(row.recorded_at);
    if (row.workspace_id !== scope.workspaceId || row.owner_user_id !== scope.ownerUserId || row.course_id !== input.courseId
      || row.requirement_key !== input.requirementKey) reason = "scope_conflict";
    else if (![row.id, row.attempt_id, row.problem_id, row.item_version_id].every(uuid) || !text(row.skill_label)
      || ids.get(row.id) !== 1 || attempts.get(row.attempt_id) !== 1 || problems.get(row.problem_id) !== 1
      || row.has_conflicting_history !== false) reason = "identity_conflict";
    else if (row.effective_head_id !== row.id || ![null, row.id].includes(row.root_observation_id as null | string)
      || row.revises_observation_id !== null || row.revision_kind !== "original") reason = "non_original_or_invalidated_head";
    else if (row.attempt_problem_id !== row.problem_id || row.attempt_item_version_id !== row.item_version_id
      || row.item_problem_id !== row.problem_id || row.attempt_observation_id !== row.id
      || row.attempt_requirement_key !== row.requirement_key) reason = "attempt_item_conflict";
    else if (!Number.isFinite(attempted) || !Number.isFinite(recorded) || attempted > recorded || attempted >= cutoff || recorded >= cutoff
      || !Number.isFinite(time(row.attempt_started_at)) || time(row.attempt_started_at) > attempted
      || !Number.isFinite(time(row.item_created_at)) || time(row.item_created_at) > time(row.attempt_started_at)) reason = "dual_time_unavailable";
    else if (time(row.attempt_submitted_at) !== attempted) reason = "attempt_item_conflict";
    else if (!family) reason = "canonical_family_unavailable";
    else if (catalogueCounts.get(catalogueKey(row)) !== 1) reason = "canonical_problem_conflict";
    else if (family === targetFamily || heldOutFamilies.has(family) || row.problem_id === input.problemId
      || excluded.has(String(row.id)) || excluded.has(String(row.problem_id))) reason = "held_out_or_target_family";
    else if (!Array.isArray(row.source_ids) || !row.source_ids.every(uuid) || !row.source_versions
      || typeof row.source_versions !== "object" || Array.isArray(row.source_versions)
      || Object.entries(row.source_versions).some(([id, version]) => !uuid(id) || !Number.isSafeInteger(version) || Number(version) < 1)
      || row.source_ids.some(id => !Object.hasOwn(row.source_versions as object, id))) reason = "source_metadata_unavailable";
    else if (row.head_observation_id !== row.id || revision(row.head_revision) !== revision(row.workspace_history_revision)
      || revision(row.head_revision) === null || row.head_revision === "0" || row.head_revision === 0
      || BigInt(String(row.head_revision)) > BigInt(rev) || revision(row.input_revision) !== rev || row.policy_version !== policyVersion
      || row.sources_current !== true || row.item_current !== true || row.item_matches !== true
      || row.version_applicability !== "exact") reason = "qualification_unavailable";
    else if (row.has_ai !== false || row.verdict_source !== "deterministic" || !Array.isArray(row.reason_codes)
      || row.reason_codes.some(code => typeof code !== "string" || code.startsWith("ai_"))) reason = "non_deterministic_or_ai";
    else if (row.has_course_help !== false || row.answer_conditions !== false || row.assistance !== "independent"
      || row.independent_attempt !== "yes" || row.usable_for_current_version !== "yes"
      || !["yes", "no"].includes(String(row.verified_correct))) reason = "non_independent_or_unknown";
    else if (row.outcome !== (row.verified_correct === "yes" ? "correct" : "incorrect")
      || !row.reason_codes.includes(row.verified_correct === "yes" ? "deterministic_correct" : "deterministic_incorrect")) reason = "outcome_conflict";
    if (reason) { result.excluded[reason] = (result.excluded[reason] ?? 0) + 1; continue; }
    const eligibility: LearnerStateFeature["eligibility"] = { policyVersion, independentAttempt: "yes", verifiedCorrect: row.verified_correct as "yes" | "no",
      usableForCurrentVersion: "yes", usableForDelayedCheck: "unknown",
      reasonCodes: [row.verified_correct === "yes" ? "deterministic_correct" : "deterministic_incorrect", "version_exact"] };
    const feature: LearnerStateFeature = { observationId: String(row.id), attemptId: String(row.attempt_id), courseId: input.courseId,
      requirementKey: input.requirementKey, itemVersionId: String(row.item_version_id), skillLabel: String(row.skill_label),
      attemptedAt: new Date(attempted).toISOString(), recordedAt: new Date(recorded).toISOString(),
      sourceIds: [...row.source_ids as string[]], sourceVersions: { ...row.source_versions as Record<string, number> },
      eligibility, availability: "available", views: ["independent"],
      transfer: { usable: "unknown", knowledgeComponents: [], reasonCodes: ["transfer_specification_not_recorded"] },
      retention: { protocolId: null, earliestAt: null, recordedIntervalSupportCount: null, intervalExposureComplete: null },
      gaps: ["retention_protocol_not_recorded", "transfer_not_projected"],
      outcome: row.outcome as "correct" | "incorrect", ordinal: result.features.length };
    result.features.push(feature);
    result.observationHeads.push({ id: feature.observationId, skillLabel: feature.skillLabel, requirementKey: input.requirementKey,
      problemId: String(row.problem_id), itemVersionId: feature.itemVersionId, attemptedAt: feature.attemptedAt,
      assistance: "independent", independentAttempt: "yes", verifiedCorrect: eligibility.verifiedCorrect, usableForCurrentVersion: "yes" });
    result.families.push({ observationId: feature.observationId, familyId: family!, provenance: "span_catalogue" });
  }
  return result.features.length ? { ...result, status: "available", reason: null } : unavailable("no_qualified_heads");
}

/** Only public execution entry: owns one consistent, read-only transaction.
 * SQL errors propagate (no fake success or hidden retry). No endpoint/export wiring.
 */
export function createOpeningExperimentalBktSnapshotRepository(sql: Sql) {
  return { read: (scope: Scope, input: ExperimentalBktSnapshotInput): Promise<ExperimentalBktSnapshot> =>
    sql.begin("isolation level repeatable read read only", async tx => {
      if (![scope.workspaceId, scope.ownerUserId, input.courseId, input.problemId, input.itemVersionId].every(uuid)
        || !text(input.requirementKey) || !Number.isFinite(time(input.cutoff)) || !validHeldOutIds(input.excludedProblemIds)) {
        return projectOpeningExperimentalBktSnapshot(scope, input, {}, undefined, []);
      }
      const [context] = await tx`SELECT w.id AS workspace_id,w.owner_user_id,c.id AS course_id,
          clock_timestamp() AS data_as_of,txid_current_snapshot()::text AS snapshot_token,h.revision
        FROM workspaces w JOIN courses c ON c.workspace_id=w.id AND c.id=${input.courseId} AND c.archived_at IS NULL
        LEFT JOIN opening_workspace_history_revisions h ON h.workspace_id=w.id AND h.owner_user_id=w.owner_user_id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      if (!context || revision(context.revision) === null || !Number.isFinite(time(context.data_as_of))
        || time(input.cutoff) > time(context.data_as_of)) {
        return projectOpeningExperimentalBktSnapshot(scope, input, context ?? {}, undefined, []);
      }
      const [target] = await tx`SELECT v.id,v.workspace_id,v.owner_user_id,v.course_id,v.problem_id,v.created_at AS target_created_at,
          (EXISTS (SELECT 1 FROM opening_problem_refs r WHERE r.problem_id=v.problem_id AND r.workspace_id=v.workspace_id
              AND r.source_id IS NOT DISTINCT FROM v.source_id AND r.source_version IS NOT DISTINCT FROM v.source_version
              AND r.stem_snapshot=v.stem_snapshot AND r.artifact_kind=v.artifact_kind
              AND r.physical_page IS NOT DISTINCT FROM v.physical_page AND r.chunk_id IS NOT DISTINCT FROM v.chunk_id
              AND r.teaching_revision_id IS NOT DISTINCT FROM v.teaching_revision_id
              AND r.teaching_block_id IS NOT DISTINCT FROM v.teaching_block_id)
            AND (v.source_id IS NULL OR EXISTS (SELECT 1 FROM opening_sources s WHERE s.id=v.source_id
              AND s.workspace_id=v.workspace_id AND s.version=v.source_version AND s.upload_state='uploaded'
              AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
              AND NOT EXISTS (SELECT 1 FROM opening_source_versions sv WHERE sv.workspace_id=s.workspace_id
                AND sv.source_id=s.id AND sv.version=s.version AND sv.availability='unavailable')))) AS target_current,
          jsonb_build_object('kind',v.evaluation_spec->'kind','specVersion',v.evaluation_spec->'specVersion',
            'problemId',v.evaluation_spec->'problemId','version',v.evaluation_spec->'version',
            'familyId',v.evaluation_spec->'familyId','requirementKey',v.evaluation_spec->'requirementKey') AS spec_metadata
        FROM opening_learning_item_versions v WHERE v.id=${input.itemVersionId} AND v.problem_id=${input.problemId}
          AND v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.course_id=${input.courseId}`;
      const heldOutRows = input.excludedProblemIds?.length ? await openingExperimentalBktHeldOutQuery(tx, scope, input) : [];
      if (!resolveHeldOutFamilies(scope, input, heldOutRows, time(context.data_as_of))) {
        return projectOpeningExperimentalBktSnapshot(scope, input, context, target, [], heldOutRows);
      }
      const rows = await openingExperimentalBktHeadsQuery(tx, scope, input);
      return projectOpeningExperimentalBktSnapshot(scope, input, context, target, rows, heldOutRows);
    }) as Promise<ExperimentalBktSnapshot> };
}
