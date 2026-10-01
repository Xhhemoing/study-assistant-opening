import { isDeepStrictEqual } from "node:util";
import type { Sql, TransactionSql } from "postgres";
import type { Scope } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { lockWorkspaceLearningHistory, mapLearningObservation, type LearningSql } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts, type OpeningEvidenceInput } from "./opening-learning-evidence-context";

type Row = Record<string, unknown>;
// The evaluator owns this version. No second policy literal is maintained here.
export const openingEligibilityPolicyVersion = () => evaluateEvidenceEligibility({ assistance: "independent", outcome: "unverified", verdictSource: "self_report" }, {}).policyVersion;

/** SQL references are identifiers from fixed internal aliases, never HTTP input. */
function sourceReferences(db: LearningSql, alias: "o" | "chain") {
  return db.unsafe(`SELECT unnest(${alias}.source_ids)::text AS source_id
    UNION SELECT jsonb_object_keys(COALESCE(${alias}.source_versions,'{}'::jsonb))
    UNION SELECT ${alias}.reference_source_id::text
    UNION SELECT ${alias}.reference_check->>'referenceId'`);
}

/** Live dependencies are checked for every head before aggregation, including rows outside display limits. */
export function openingEligibilityStateQuery(db: LearningSql, scope: Scope, filter: {
  courseId?: string; rootIds?: readonly string[]; groups?: ReadonlyArray<{ skillLabel: string; requirementKey: string | null }>;
} = {}) {
  const groupJson = JSON.stringify(filter.groups ?? []);
  return db`WITH heads AS (
    SELECT o.*,root.id AS current_root_id FROM opening_learning_observations o
    JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
      AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id
      AND COALESCE(root.effective_head_id,root.id)=o.id
    WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
      AND COALESCE(o.revision_kind,'original')<>'retract'
      AND ${filter.courseId ? db`o.course_id=${filter.courseId}` : db`TRUE`}
      AND ${filter.rootIds ? filter.rootIds.length ? db`root.id=ANY(${[...filter.rootIds]}::uuid[])` : db`FALSE` : db`TRUE`}
      AND ${filter.groups ? db`EXISTS (SELECT 1 FROM jsonb_to_recordset(${groupJson}::text::jsonb) AS g("skillLabel" text,"requirementKey" text)
        WHERE g."skillLabel"=o.skill_label AND g."requirementKey" IS NOT DISTINCT FROM o.requirement_key)` : db`TRUE`}
  ), live AS (
    SELECT o.*,COALESCE(help.revision,0) AS live_help_revision,
      EXISTS(SELECT 1 FROM opening_learning_item_versions v JOIN opening_problem_refs r
        ON r.problem_id=v.problem_id AND r.workspace_id=v.workspace_id
          AND r.source_id=v.source_id AND r.source_version=v.source_version AND r.stem_snapshot=v.stem_snapshot
          AND r.chunk_id IS NOT DISTINCT FROM v.chunk_id AND r.physical_page IS NOT DISTINCT FROM v.physical_page AND r.artifact_kind=v.artifact_kind
        WHERE v.id=o.item_version_id AND v.workspace_id=o.workspace_id AND v.owner_user_id=o.owner_user_id) AS live_item_matches,
      COALESCE(sources.states,'[]'::jsonb) AS live_source_states,COALESCE(privacy.ids,ARRAY[]::text[]) AS live_privacy_ids
    FROM heads o
    LEFT JOIN LATERAL (SELECT max(h.history_revision) AS revision FROM opening_help_exposures h
      JOIN opening_learning_sessions l ON l.id=h.session_id AND l.workspace_id=h.workspace_id
      JOIN opening_learning_sessions origin ON origin.id=o.session_id AND origin.workspace_id=o.workspace_id AND origin.owner_user_id=o.owner_user_id
      WHERE h.workspace_id=o.workspace_id AND l.owner_user_id=o.owner_user_id AND l.course_id=origin.course_id
        AND (h.attempt_id=o.attempt_id OR h.problem_id=o.problem_id OR (h.attempt_id IS NULL AND h.problem_id IS NULL AND h.session_id=o.session_id))) help ON TRUE
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('sourceId',ids.source_id,'version',s.version,
        'uploaded',COALESCE(s.upload_state='uploaded',FALSE),'historicalUnavailable',EXISTS(SELECT 1 FROM opening_source_versions v
          WHERE v.workspace_id=o.workspace_id AND v.source_id::text=ids.source_id AND v.version::text=o.source_versions->>ids.source_id AND v.availability='unavailable'))
        ORDER BY ids.source_id COLLATE "C") AS states
      FROM (${sourceReferences(db, "o")}) ids LEFT JOIN opening_sources s ON s.workspace_id=o.workspace_id AND s.id::text=ids.source_id
      WHERE ids.source_id IS NOT NULL AND ids.source_id<>'') sources ON TRUE
    LEFT JOIN LATERAL (SELECT array_agg(DISTINCT refs.source_id ORDER BY refs.source_id) AS ids
      FROM opening_learning_observations chain CROSS JOIN LATERAL (${sourceReferences(db, "chain")}) refs
      WHERE chain.workspace_id=o.workspace_id AND chain.owner_user_id=o.owner_user_id
        AND COALESCE(chain.root_observation_id,chain.id)=o.current_root_id AND refs.source_id IS NOT NULL AND refs.source_id<>'') privacy ON TRUE
  ) SELECT live.*,p.head_observation_id AS projected_head_id,p.input_revision AS projected_input_revision,p.policy_version AS projected_policy_version,
    p.independent_attempt,p.verified_correct,p.usable_for_current_version,p.usable_for_delayed_check,p.reason_codes,p.version_applicability,
    COALESCE(p.head_observation_id=live.id AND p.head_revision=live.workspace_history_revision
      AND p.policy_version=${openingEligibilityPolicyVersion()} AND p.help_revision=live.live_help_revision
      AND p.item_matches=live.live_item_matches AND p.source_states=live.live_source_states AND p.privacy_source_ids=live.live_privacy_ids,FALSE) AS fresh,
    EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=live.workspace_id AND e.source_id::text=ANY(live.live_privacy_ids)) AS privacy_excluded
    FROM live LEFT JOIN opening_learning_eligibility p ON p.workspace_id=live.workspace_id AND p.owner_user_id=live.owner_user_id AND p.root_observation_id=live.current_root_id`;
}

export async function invalidateOpeningLearningEligibility(tx: TransactionSql, scope: Scope, input: { sourceIds?: readonly string[]; rootIds?: readonly string[] }): Promise<void> {
  if (!input.sourceIds?.length && !input.rootIds?.length) return;
  await tx`DELETE FROM opening_learning_eligibility p WHERE p.workspace_id=${scope.workspaceId} AND p.owner_user_id=${scope.ownerUserId}
    AND (${input.rootIds?.length ? tx`p.root_observation_id=ANY(${[...input.rootIds]}::uuid[])` : tx`FALSE`}
      OR ${input.sourceIds?.length ? tx`p.privacy_source_ids && ${[...input.sourceIds]}::text[]` : tx`FALSE`})`;
}

async function writeProjections(tx: TransactionSql, scope: Scope, entries: Array<{ row: Row; evidence: OpeningEvidenceInput }>, revision: number, compare: boolean): Promise<number> {
  if (!entries.length) return 0;
  const inputs = entries.map(({ row, evidence }) => {
    const eligibility = evaluateEvidenceEligibility(evidence.observation, evidence.context), d = evidence.dependencies;
    return { root_id: String(row.current_root_id ?? row.root_observation_id ?? row.id), head_id: row.id, head_revision: row.workspace_history_revision,
      policy_version: eligibility.policyVersion, help_revision: d.helpRevision, item_matches: d.itemMatches, source_states: d.sourceStates,
      privacy_ids: d.privacySourceIds, independent_attempt: eligibility.independentAttempt, verified_correct: eligibility.verifiedCorrect,
      usable_current: eligibility.usableForCurrentVersion, usable_delayed: eligibility.usableForDelayedCheck, reasons: eligibility.reasonCodes,
      applicability: evidence.context.version?.applicability ?? "version_unknown", old_head: row.projected_head_id ?? null,
      old_revision: row.projected_input_revision ?? null, old_policy: row.projected_policy_version ?? null };
  });
  const installed = await tx`WITH inputs AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(inputs)}::text::jsonb) AS x(
      root_id uuid,head_id uuid,head_revision bigint,policy_version text,help_revision bigint,item_matches boolean,source_states jsonb,
      privacy_ids text[],independent_attempt text,verified_correct text,usable_current text,usable_delayed text,reasons text[],applicability text,
      old_head uuid,old_revision bigint,old_policy text))
    INSERT INTO opening_learning_eligibility(workspace_id,owner_user_id,root_observation_id,head_observation_id,head_revision,input_revision,
      policy_version,help_revision,item_matches,source_states,privacy_source_ids,independent_attempt,verified_correct,usable_for_current_version,usable_for_delayed_check,reason_codes,version_applicability)
    SELECT ${scope.workspaceId},${scope.ownerUserId},root_id,head_id,head_revision,${revision},policy_version,help_revision,item_matches,source_states,
      privacy_ids,independent_attempt,verified_correct,usable_current,usable_delayed,reasons,applicability FROM inputs
    ON CONFLICT(workspace_id,owner_user_id,root_observation_id) DO UPDATE SET head_observation_id=EXCLUDED.head_observation_id,head_revision=EXCLUDED.head_revision,
      input_revision=EXCLUDED.input_revision,policy_version=EXCLUDED.policy_version,help_revision=EXCLUDED.help_revision,item_matches=EXCLUDED.item_matches,
      source_states=EXCLUDED.source_states,privacy_source_ids=EXCLUDED.privacy_source_ids,independent_attempt=EXCLUDED.independent_attempt,
      verified_correct=EXCLUDED.verified_correct,usable_for_current_version=EXCLUDED.usable_for_current_version,
      usable_for_delayed_check=EXCLUDED.usable_for_delayed_check,reason_codes=EXCLUDED.reason_codes,version_applicability=EXCLUDED.version_applicability
    WHERE ${!compare} OR EXISTS(SELECT 1 FROM inputs i WHERE i.root_id=opening_learning_eligibility.root_observation_id
      AND opening_learning_eligibility.head_observation_id IS NOT DISTINCT FROM i.old_head
      AND opening_learning_eligibility.input_revision IS NOT DISTINCT FROM i.old_revision
      AND opening_learning_eligibility.policy_version IS NOT DISTINCT FROM i.old_policy)
    RETURNING root_observation_id`;
  return installed.length;
}
/** Called last in an existing counter-first fact transaction. Retractions delete derived rows. */
export async function refreshOpeningLearningEligibility(tx: TransactionSql, scope: Scope, rootIds: readonly string[]): Promise<void> {
  await invalidateOpeningLearningEligibility(tx, scope, { rootIds });
  const rows = await openingEligibilityStateQuery(tx, scope, { rootIds });
  const inputs = await readOpeningLearningEvidenceContexts(tx, scope, rows.map(mapLearningObservation));
  const [counter] = await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
  await writeProjections(tx, scope, rows.map(row => ({ row, evidence: inputs[String(row.id)]! })), Number(counter?.revision ?? 0), false);
}

/** Calculate without locks, then conditionally install a bounded batch. No fire-and-forget work. */
export async function repairOpeningLearningEligibility(sql: Sql, scope: Scope, filter: { courseId: string; groups: ReadonlyArray<{ skillLabel: string; requirementKey: string | null }> }, limit = 100): Promise<number> {
  const batch = await sql.begin("isolation level repeatable read read only", async tx => {
    const [counter] = await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    const rows = await tx`SELECT * FROM (${openingEligibilityStateQuery(tx, scope, filter)}) q WHERE NOT fresh AND NOT privacy_excluded ORDER BY current_root_id LIMIT ${Math.max(1, Math.min(limit, 200))}`;
    return { revision: Number(counter?.revision ?? 0), rows, inputs: await readOpeningLearningEvidenceContexts(tx, scope, rows.map(mapLearningObservation)) };
  });
  if (!batch.rows.length) return 0;
  return sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, scope);
    const [counter] = await tx`SELECT revision FROM opening_workspace_history_revisions WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
    if (Number(counter?.revision ?? 0) !== batch.revision) return 0;
    const live = await openingEligibilityStateQuery(tx, scope, { rootIds: batch.rows.map(row => String(row.current_root_id)) });
    const byRoot = new Map(live.map(row => [String(row.current_root_id), row]));
    const accepted: Array<{ row: Row; evidence: OpeningEvidenceInput }> = [];
    for (const row of batch.rows) {
      const current = byRoot.get(String(row.current_root_id)), evidence = batch.inputs[String(row.id)]!, d = evidence.dependencies;
      if (!current || current.id !== row.id || current.privacy_excluded || Number(current.live_help_revision) !== d.helpRevision
        || current.live_item_matches !== d.itemMatches || !isDeepStrictEqual(current.live_source_states, d.sourceStates)
        || !isDeepStrictEqual(current.live_privacy_ids, d.privacySourceIds)) continue;
      accepted.push({ row, evidence });
    }
    return writeProjections(tx, scope, accepted, batch.revision, true);
  }) as Promise<number>;
}
