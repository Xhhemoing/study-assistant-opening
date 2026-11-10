import type { LearningSql } from "./opening-learning-facts";

/** Correlated with fixed internal aliases v (target item) and h (real receipt).
 * Publication UUIDs are not question identity. Resolve both immutable revisions
 * within the same owned activity/unit/block/source scope; never trust a title,
 * caller stem or a rewrite's claim of equivalence. Compare the entire saved
 * context, ignoring only target rewrite metadata and bound answer text fields
 * that reference-only adoption is allowed to change. Changed conditions/options/
 * units/figures do not match. This is exact provenance, not semantic equivalence.
 * Shared by evidence loading and live projection dependencies so old cached
 * positives become stale without rewriting facts or bumping a public contract.
 */
export function unchangedTeachingQuestionHelpMatches(db: LearningSql) {
  return db`EXISTS (SELECT 1 FROM opening_learning_item_versions prior
    JOIN library_revisions old_revision ON old_revision.id=prior.teaching_revision_id
      AND old_revision.workspace_id=prior.workspace_id
      AND old_revision.document_id::text=prior.evaluation_spec->>'documentId'
      AND old_revision.revision_number::text=prior.evaluation_spec->>'revisionNumber'
    JOIN library_revisions now_revision ON now_revision.id=v.teaching_revision_id
      AND now_revision.workspace_id=v.workspace_id
      AND now_revision.document_id=old_revision.document_id
      AND now_revision.document_id::text=v.evaluation_spec->>'documentId'
      AND now_revision.revision_number::text=v.evaluation_spec->>'revisionNumber'
    JOIN opening_teaching_units unit ON unit.document_id=now_revision.document_id
      AND unit.workspace_id=v.workspace_id AND unit.owner_user_id=v.owner_user_id
      AND unit.id::text=v.evaluation_spec->>'teachingUnitId'
    WHERE prior.workspace_id=v.workspace_id AND prior.owner_user_id=v.owner_user_id
      AND prior.course_id=v.course_id AND prior.activity_id=v.activity_id
      AND prior.teaching_block_id=v.teaching_block_id AND prior.stem_snapshot=v.stem_snapshot
      AND prior.teaching_revision_id IS DISTINCT FROM v.teaching_revision_id
      AND v.evaluation_spec->>'kind'='teaching_question'
      AND prior.evaluation_spec->>'kind'='teaching_question'
      AND v.evaluation_spec->>'specVersion'='teaching-question-v1'
      AND prior.evaluation_spec->>'specVersion'='teaching-question-v1'
      AND v.evaluation_spec->>'revisionId'=v.teaching_revision_id::text
      AND prior.evaluation_spec->>'revisionId'=prior.teaching_revision_id::text
      AND v.evaluation_spec->>'blockId'=v.teaching_block_id::text
      AND prior.evaluation_spec->>'blockId'=prior.teaching_block_id::text
      AND v.evaluation_spec->>'activityId'=v.activity_id::text
      AND prior.evaluation_spec->>'activityId'=prior.activity_id::text
      AND prior.evaluation_spec->>'teachingUnitId'=v.evaluation_spec->>'teachingUnitId'
      AND prior.evaluation_spec->'sourceRefs'=v.evaluation_spec->'sourceRefs'
      AND prior.evaluation_spec->'answerBlockId'=v.evaluation_spec->'answerBlockId'
      AND h.workspace_id=prior.workspace_id AND h.owner_user_id=prior.owner_user_id
      AND h.course_id=prior.course_id AND h.delivered=TRUE
      AND (h.item_version_id=prior.id OR (h.item_version_id IS NULL
        AND h.context_anchor->>'activityId'=prior.activity_id::text
        AND h.context_anchor->>'blockId'=prior.teaching_block_id::text
        AND h.context_anchor->>'contentVersion'=prior.evaluation_spec->>'contentVersion'))
      AND (SELECT jsonb_agg(CASE
          WHEN b->>'id'=v.teaching_block_id::text THEN jsonb_set(b,'{content}',(b->'content')-'rewriteOf')
          WHEN b->>'id'=v.evaluation_spec->>'answerBlockId' AND b->>'type' IN ('answer_key','solution')
            THEN jsonb_set(b,'{content}',(b->'content')-ARRAY['text','markdown','answer','solution'])
          ELSE b END ORDER BY ord)
        FROM jsonb_array_elements(now_revision.blocks) WITH ORDINALITY AS block(b,ord))
        = (SELECT jsonb_agg(CASE
          WHEN b->>'id'=prior.teaching_block_id::text THEN jsonb_set(b,'{content}',(b->'content')-'rewriteOf')
          WHEN b->>'id'=prior.evaluation_spec->>'answerBlockId' AND b->>'type' IN ('answer_key','solution')
            THEN jsonb_set(b,'{content}',(b->'content')-ARRAY['text','markdown','answer','solution'])
          ELSE b END ORDER BY ord)
        FROM jsonb_array_elements(old_revision.blocks) WITH ORDINALITY AS block(b,ord)))`;
}
