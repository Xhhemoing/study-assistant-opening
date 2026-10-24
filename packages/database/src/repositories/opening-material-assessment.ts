import { isDeepStrictEqual } from "node:util";
import { aiGradingMaterialProvenanceSchema, type AiEvaluation, type AiGradingMaterialProvenance, type Scope } from "@aistudy/contracts";
import { learningError, type LearningSql } from "./opening-learning-facts";

/** Live dependencies are separate from source-byte applicability and item identity. */
export type OpeningMaterialAssessmentState = {
  materialSourceRefs: Array<{ sourceId: string; sourceVersion: number | null; manifestRevision: number | null }>;
  materialAnswerRefs: AiGradingMaterialProvenance["materialAnswerRefs"];
  disputed: boolean;
};

/** Shared by grading capture, batch qualification and projection freshness/CAS.
 * All reverse links (not just trusted/currently readable text) participate, so
 * unverified→trusted and disputed→trusted are real changes. The owning manifest
 * writer must monotonically advance affected question metadata too: otherwise a
 * newly added and then removed external link could restore a previous empty set.
 * This query contains no answer text and never grants permission to release it. */
export function openingMaterialAssessmentStateQuery(db: LearningSql, alias: string) {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("invalid internal observation alias");
  return db.unsafe(`WITH item AS (
    SELECT v.* FROM opening_learning_item_versions v WHERE v.id=${alias}.item_version_id
      AND v.workspace_id=${alias}.workspace_id AND v.owner_user_id=${alias}.owner_user_id
  ), linked AS (
    SELECT mv.source_id,mv.version,mv.material_manifest_revision,
      bool_or(ma->>'status'='disputed') AS disputed
    FROM item v JOIN opening_source_versions mv ON mv.workspace_id=v.workspace_id
    JOIN opening_sources ms ON ms.id=mv.source_id AND ms.workspace_id=mv.workspace_id AND ms.version=mv.version
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(mv.material_manifest->'answers','[]'::jsonb)) ma
    WHERE v.evaluation_spec->>'kind'='material_question'
      AND ma->>'questionSourceId'=v.source_id::text AND ma->>'questionSourceVersion'=v.source_version::text
      AND ma->'question'->>'family'=v.evaluation_spec->>'family'
      AND ma->'question'->>'number'=v.evaluation_spec->>'number'
      AND ma->'question'->>'subquestion'=v.evaluation_spec->>'subquestion'
    GROUP BY mv.source_id,mv.version,mv.material_manifest_revision
  ), ids AS (
    SELECT unnest(${alias}.source_ids)::text AS id
    UNION SELECT jsonb_object_keys(COALESCE(${alias}.source_versions,'{}'::jsonb))
    UNION SELECT ${alias}.reference_source_id::text
    UNION SELECT ${alias}.reference_check->>'referenceId'
    UNION SELECT source_id::text FROM item
    UNION SELECT source_id::text FROM linked
  ) SELECT jsonb_build_object(
    'materialSourceRefs',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'sourceId',ids.id,'sourceVersion',s.version,
      'manifestRevision',CASE WHEN s.id IS NULL THEN NULL ELSE COALESCE(mv.material_manifest_revision,0) END)
      ORDER BY ids.id COLLATE "C")
      FROM ids LEFT JOIN opening_sources s ON s.id::text=ids.id AND s.workspace_id=${alias}.workspace_id
      LEFT JOIN opening_source_versions mv ON mv.source_id=s.id AND mv.version=s.version AND mv.workspace_id=s.workspace_id
      WHERE ids.id IS NOT NULL AND ids.id<>''
        AND ids.id IS DISTINCT FROM ${alias}.grading_work_source->>'id'), '[]'::jsonb),
    'materialAnswerRefs',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'sourceId',source_id,'sourceVersion',version,'manifestRevision',material_manifest_revision)
      ORDER BY source_id::text COLLATE "C") FROM linked), '[]'::jsonb),
    'disputed',COALESCE((SELECT bool_or(disputed) FROM linked),FALSE)
  ) AS state`);
}

export async function readOpeningMaterialAssessmentStates(db: LearningSql, scope: Scope, observationIds: readonly string[]) {
  if (!observationIds.length) return new Map<string, OpeningMaterialAssessmentState>();
  const rows = await db`SELECT o.id,material.state FROM opening_learning_observations o
    CROSS JOIN LATERAL (${openingMaterialAssessmentStateQuery(db, "o")}) material
    WHERE o.id=ANY(${[...observationIds]}::uuid[]) AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}`;
  return new Map(rows.map(row => [String(row.id), row.state as OpeningMaterialAssessmentState]));
}

export function captureOpeningMaterialProvenance(state: OpeningMaterialAssessmentState): AiGradingMaterialProvenance {
  return aiGradingMaterialProvenanceSchema.parse({ materialAnswerRefs: state.materialAnswerRefs, materialSourceRefs: state.materialSourceRefs });
}

export function assertOpeningMaterialProvenance(expected: AiGradingMaterialProvenance, live: AiGradingMaterialProvenance): void {
  const captured = aiGradingMaterialProvenanceSchema.parse(expected);
  if (!isDeepStrictEqual(captured, live)) throw learningError("CONFLICT", "批改使用的答案或资料分类已修订，请核验后重新作答；原答案已保存。");
}

/** Legacy classified assessments have no provable revision; unclassified legacy
 * sources remain compatible until their metadata first changes. Never fill a
 * historical assessment from the latest manifest. */
export function openingMaterialAssessmentValidity(evaluation: AiEvaluation | null | undefined, state: OpeningMaterialAssessmentState): "current" | "changed" | "unknown" {
  if (!evaluation) return "current";
  if (!evaluation.materialAnswerRefs || !evaluation.materialSourceRefs) {
    return state.materialAnswerRefs.length || state.materialSourceRefs.some(ref => ref.manifestRevision !== 0)
      ? "unknown" : "current";
  }
  return isDeepStrictEqual(evaluation.materialAnswerRefs, state.materialAnswerRefs)
    && isDeepStrictEqual(evaluation.materialSourceRefs, state.materialSourceRefs) ? "current" : "changed";
}
