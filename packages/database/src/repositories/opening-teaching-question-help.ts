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
    CROSS JOIN LATERAL (SELECT array_agg(binding.answer_id) AS ids FROM (
      -- Issued items retain a server-resolved binding for historical publications.
      SELECT item.evaluation_spec->>'answerBlockId' AS answer_id
      FROM opening_learning_item_versions item
      WHERE item.workspace_id=v.workspace_id AND item.owner_user_id=v.owner_user_id
        AND item.course_id=v.course_id AND item.activity_id=v.activity_id
        AND item.teaching_revision_id IN (v.teaching_revision_id,prior.teaching_revision_id)
        AND item.evaluation_spec->>'kind'='teaching_question'
        AND item.evaluation_spec->>'specVersion'='teaching-question-v1'
        AND item.evaluation_spec->>'teachingUnitId'=unit.id::text
        AND item.evaluation_spec->>'documentId'=now_revision.document_id::text
        AND item.evaluation_spec->>'revisionId'=item.teaching_revision_id::text
        AND item.evaluation_spec->>'revisionNumber'=CASE WHEN item.teaching_revision_id=now_revision.id
          THEN now_revision.revision_number::text ELSE old_revision.revision_number::text END
        AND item.evaluation_spec->>'activityId'=item.activity_id::text
        AND item.evaluation_spec->>'blockId'=item.teaching_block_id::text
      UNION
      -- A pinned publication proves bindings even for questions never attempted.
      -- Raw answer blocks or their physical adjacency are not binding evidence.
      SELECT ordered.answer_ref->>'blockId' FROM opening_teaching_activity_specs spec
      CROSS JOIN LATERAL (SELECT ref,
          lead(ref) OVER (ORDER BY (ref->>'position')::int, ref_ordinality) AS answer_ref
        FROM jsonb_array_elements(spec.block_order) WITH ORDINALITY AS refs(ref,ref_ordinality)) ordered
      WHERE spec.workspace_id=v.workspace_id AND spec.owner_user_id=v.owner_user_id
        AND spec.activity_id=v.activity_id AND spec.teaching_unit_id=unit.id
        AND spec.document_id=now_revision.document_id
        AND spec.revision_number IN (now_revision.revision_number,old_revision.revision_number)
        AND ordered.ref->>'role'<>'answer_key'
        AND (ordered.ref->>'role'='prompt' OR ordered.ref->>'blockType' IN ('prompt','question'))
        AND (ordered.answer_ref->>'role'='answer_key' OR ordered.answer_ref->>'blockType' IN ('answer_key','solution'))
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(now_revision.blocks) prompt
          WHERE prompt->>'id'=ordered.ref->>'blockId' AND prompt->>'type' IN ('prompt','question')
            AND EXISTS (SELECT 1 FROM jsonb_each(prompt->'content') field
              WHERE field.key IN ('text','markdown','prompt','question','answer','solution')
                AND jsonb_typeof(field.value)='string' AND btrim(field.value#>>'{}')<>''))
    ) binding) bound_answers
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
      AND ((SELECT jsonb_agg(CASE
          WHEN b->>'id'=v.teaching_block_id::text THEN jsonb_set(b,'{content}',(b->'content')-'rewriteOf')
          WHEN b->>'id'=ANY(bound_answers.ids) AND b->>'type' IN ('answer_key','solution')
            THEN jsonb_set(b,'{content}',(b->'content')-ARRAY['text','markdown','answer','solution'])
          ELSE b END ORDER BY ord)
        FROM jsonb_array_elements(now_revision.blocks) WITH ORDINALITY AS block(b,ord))
        = (SELECT jsonb_agg(CASE
          WHEN b->>'id'=prior.teaching_block_id::text THEN jsonb_set(b,'{content}',(b->'content')-'rewriteOf')
          WHEN b->>'id'=ANY(bound_answers.ids) AND b->>'type' IN ('answer_key','solution')
            THEN jsonb_set(b,'{content}',(b->'content')-ARRAY['text','markdown','answer','solution'])
          ELSE b END ORDER BY ord)
        FROM jsonb_array_elements(old_revision.blocks) WITH ORDINALITY AS block(b,ord))
      OR EXISTS (
        -- A chain composes only restricted same-question revisions and durable
        -- example appends with an EXACT immutable prefix. No prose equivalence,
        -- changed conditions/options/units/figures or dropped blocks.
        WITH RECURSIVE example_appends AS (
          SELECT first.id,first.revision_number,first.blocks FROM library_revisions first
          WHERE first.id=CASE WHEN old_revision.revision_number<now_revision.revision_number THEN old_revision.id ELSE now_revision.id END
          UNION ALL
          SELECT next.id,next.revision_number,next.blocks FROM example_appends previous
          JOIN library_revisions next ON next.workspace_id=v.workspace_id AND next.document_id=now_revision.document_id
            AND next.parent_revision_number=previous.revision_number AND next.revision_number=previous.revision_number+1
            AND next.revision_number<=GREATEST(now_revision.revision_number,old_revision.revision_number)
          LEFT JOIN opening_jobs generated ON generated.workspace_id=v.workspace_id AND generated.owner_user_id=v.owner_user_id
            AND generated.kind='compile-teaching-unit' AND generated.payload->>'mode'='example'
            AND next.reason='teaching-example:' || generated.id::text
          WHERE (
            -- Compose the existing restricted same-question relation at EVERY
            -- adjacent revision, including publications with no issued attempt.
            (SELECT jsonb_agg(CASE
              WHEN b->>'id'=v.teaching_block_id::text THEN jsonb_set(b,'{content}',(b->'content')-'rewriteOf')
              WHEN b->>'id'=ANY(bound_answers.ids) AND b->>'type' IN ('answer_key','solution')
                THEN jsonb_set(b,'{content}',(b->'content')-ARRAY['text','markdown','answer','solution'])
              ELSE b END ORDER BY ord)
              FROM jsonb_array_elements(next.blocks) WITH ORDINALITY AS blocks(b,ord))
            = (SELECT jsonb_agg(CASE
              WHEN b->>'id'=v.teaching_block_id::text THEN jsonb_set(b,'{content}',(b->'content')-'rewriteOf')
              WHEN b->>'id'=ANY(bound_answers.ids) AND b->>'type' IN ('answer_key','solution')
                THEN jsonb_set(b,'{content}',(b->'content')-ARRAY['text','markdown','answer','solution'])
              ELSE b END ORDER BY ord)
              FROM jsonb_array_elements(previous.blocks) WITH ORDINALITY AS blocks(b,ord))
          ) OR (generated.payload->'blocks'=previous.blocks
            AND generated.payload->'sourceRefs'=v.evaluation_spec->'sourceRefs'
            AND generated.payload->'request'->'target'->>'activityId'=v.activity_id::text
            AND generated.payload->'request'->'target'->>'documentId'=now_revision.document_id::text
            AND generated.payload->'request'->'target'->>'revisionNumber'=previous.revision_number::text
            AND jsonb_array_length(next.blocks)=jsonb_array_length(previous.blocks)+2
            AND (SELECT jsonb_agg(b ORDER BY ord) FROM jsonb_array_elements(next.blocks) WITH ORDINALITY AS prefix(b,ord)
              WHERE ord<=jsonb_array_length(previous.blocks))=previous.blocks
            AND next.blocks->-2->>'type'='example' AND next.blocks->-1->>'type'='steps'
            AND next.blocks->-2->'content'->'generatedExample'->>'operationId'=generated.id::text
            AND next.blocks->-1->'content'->'generatedExample'->>'operationId'=generated.id::text)
        ) SELECT 1 FROM example_appends
          WHERE id=CASE WHEN old_revision.revision_number>now_revision.revision_number THEN old_revision.id ELSE now_revision.id END
            AND old_revision.id<>now_revision.id
      )))`;
}
