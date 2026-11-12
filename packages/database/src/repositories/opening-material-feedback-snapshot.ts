import type { Sql, JSONValue } from "postgres";
import type { MaterialFeedbackAccessRequest, MaterialFeedbackSnapshot } from "../../../domain/src/opening/material-attempt-presentation";

/** External trusted host port, never deserialized from an HTTP/client payload.
 * The host authenticates the owner, authorizes post-attempt feedback and resolves
 * this exact publication/item/source and its approved payload from trusted state.
 * No generic course-package import/binding producer exists in this repository.
 */
export type OpeningMaterialFeedbackBinding = {
  workspaceId: string; ownerUserId: string; courseId: string;
  attemptId: string; itemVersionId: string; problemId: string; activityId: string;
  teachingUnitId: string; documentId: string; revisionId: string; revisionNumber: number;
  contentVersion: number; blockId: string; answerBlockId: string;
  sourceId: string; sourceVersion: number; sourceSha256: string;
  sourceFile: string; physicalPage: number;
  /** Exact saved JSON values, not client version claims or reconstructed text. */
  revisionBlocks: JSONValue; blockOrder: JSONValue; sourceRefs: JSONValue;
};
export type OpeningMaterialFeedbackHost = {
  resolvePostAttemptBinding(request: MaterialFeedbackAccessRequest): Promise<OpeningMaterialFeedbackBinding | null>;
};

type FeedbackRow = { answer: unknown };
function answerText(row: FeedbackRow): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(row, "answer");
  const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof value === "string" && value.trim() && value.length <= 20000 ? value : null;
}

/** Read-only, deliberately narrow teaching-question subset. The caller awaits
 * this read and supplies the detached snapshot to the synchronous domain port
 * for this request only. Do not cache/reuse it across requests or content edits.
 * No notes field exists on these tables: only the paired answer's text is read.
 * explicit_help always denies: a SELECT cannot durably record early exposure.
 * SQL/storage failures propagate; unavailable authority/content returns null.
 */
export function createOpeningMaterialFeedbackSnapshotRepository(sql: Sql, host: OpeningMaterialFeedbackHost) {
  return {
    async resolveFeedback(request: MaterialFeedbackAccessRequest): Promise<MaterialFeedbackSnapshot | null> {
      // Capture before invoking external code; callback mutation cannot retarget
      // either the query or its return value. The host receives a separate copy.
      const captured = { questionId: request.questionId, attemptId: request.attemptId, mode: request.mode,
        source: { file: request.source.file, page: request.source.page } };
      if (captured.mode !== "post_attempt") return null;
      const resolved = await host.resolvePostAttemptBinding({ ...captured, source: { ...captured.source } });
      if (!resolved) return null;
      const b = structuredClone(resolved);
      // Source question IDs are opaque. Only the actual stored teaching block
      // ID is supported, never guessed from a generic question number or page.
      if (captured.questionId !== b.blockId || captured.attemptId !== b.attemptId
        || captured.source.file !== b.sourceFile || captured.source.page !== b.physicalPage) return null;
      const rows = await sql<FeedbackRow[]>`SELECT key.block->'content'->>'text' AS answer
        FROM opening_learning_attempts attempt
        JOIN opening_learning_sessions session ON session.id=attempt.session_id
          AND session.workspace_id=attempt.workspace_id AND session.owner_user_id=attempt.owner_user_id
          AND session.course_id=attempt.course_id AND session.activity_id=attempt.activity_id
        JOIN opening_learning_item_versions item ON item.id=attempt.item_version_id
          AND item.workspace_id=attempt.workspace_id AND item.owner_user_id=attempt.owner_user_id
          AND item.course_id=attempt.course_id AND item.activity_id=attempt.activity_id AND item.problem_id=attempt.problem_id
        JOIN opening_teaching_activity_specs spec ON spec.workspace_id=item.workspace_id
          AND spec.owner_user_id=item.owner_user_id AND spec.activity_id=item.activity_id
        JOIN opening_teaching_activities activity ON activity.id=spec.activity_id AND activity.workspace_id=spec.workspace_id
          AND activity.owner_user_id=spec.owner_user_id AND activity.course_id=attempt.course_id
        JOIN opening_teaching_units unit ON unit.id=spec.teaching_unit_id AND unit.workspace_id=spec.workspace_id
          AND unit.owner_user_id=spec.owner_user_id AND unit.document_id=spec.document_id
        JOIN library_documents document ON document.id=spec.document_id AND document.workspace_id=spec.workspace_id
          AND document.deleted_at IS NULL AND document.current_revision_number=spec.revision_number
        JOIN library_revisions revision ON revision.document_id=spec.document_id AND revision.workspace_id=spec.workspace_id
          AND revision.revision_number=spec.revision_number AND revision.id=item.teaching_revision_id
        JOIN courses course ON course.id=attempt.course_id AND course.workspace_id=attempt.workspace_id AND course.archived_at IS NULL
        JOIN opening_sources source ON source.workspace_id=attempt.workspace_id AND source.id=${b.sourceId}
        JOIN course_asset_memberships membership ON membership.workspace_id=source.workspace_id AND membership.course_id=course.id
          AND membership.asset_type='source' AND membership.asset_id=source.id AND membership.role<>'archive'
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(revision.blocks)='array'
          THEN revision.blocks ELSE '[]'::jsonb END) prompt(block)
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(revision.blocks)='array'
          THEN revision.blocks ELSE '[]'::jsonb END) key(block)
        WHERE attempt.workspace_id=${b.workspaceId} AND attempt.owner_user_id=${b.ownerUserId} AND attempt.course_id=${b.courseId}
          AND attempt.id=${b.attemptId} AND attempt.item_version_id=${b.itemVersionId} AND attempt.problem_id=${b.problemId}
          AND attempt.activity_id=${b.activityId} AND attempt.submitted_at IS NOT NULL
          AND spec.teaching_unit_id=${b.teachingUnitId} AND spec.document_id=${b.documentId}
          AND revision.id=${b.revisionId} AND revision.revision_number=${b.revisionNumber}
          AND spec.version=${b.contentVersion} AND activity.content_version=spec.version
          AND spec.verification_status NOT IN ('rejected','stale') AND unit.verification_status NOT IN ('rejected','stale')
          AND activity.generate_status='ready' AND activity.status IN ('active','paused','completed')
          AND item.teaching_block_id=${b.blockId}
          AND item.evaluation_spec->>'kind'='teaching_question' AND item.evaluation_spec->>'specVersion'='teaching-question-v1'
          AND item.evaluation_spec->>'activityId'=activity.id::text AND item.evaluation_spec->>'teachingUnitId'=unit.id::text
          AND item.evaluation_spec->>'documentId'=document.id::text AND item.evaluation_spec->>'revisionId'=revision.id::text
          AND item.evaluation_spec->>'revisionNumber'=revision.revision_number::text
          AND item.evaluation_spec->>'contentVersion'=spec.version::text AND item.evaluation_spec->>'blockId'=item.teaching_block_id::text
          AND item.evaluation_spec->>'answerBlockId'=${b.answerBlockId}
          AND revision.blocks=${sql.json(b.revisionBlocks)} AND spec.block_order=${sql.json(b.blockOrder)}
          AND spec.source_refs=${sql.json(b.sourceRefs)} AND item.evaluation_spec->'sourceRefs'=spec.source_refs
          AND prompt.block->>'id'=${b.blockId} AND prompt.block->>'type' IN ('prompt','question')
          AND key.block->>'id'=${b.answerBlockId} AND key.block->>'type' IN ('answer_key','solution')
          AND jsonb_typeof(prompt.block->'content'->'text')='string'
          AND jsonb_typeof(key.block->'content'->'text')='string'
          AND prompt.block->'content'->>'text' ~ '[^[:space:]]'
          AND char_length(prompt.block->'content'->>'text')<=2000
          AND item.stem_snapshot=prompt.block->'content'->>'text'
          AND NOT (prompt.block->'content' ? 'interaction')
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(spec.block_order) p, jsonb_array_elements(spec.block_order) k
            WHERE p->>'blockId'=${b.blockId} AND p->>'role'='prompt' AND k->>'blockId'=${b.answerBlockId}
              AND k->>'role'='answer_key' AND (k->>'position')::int=(p->>'position')::int+1)
          AND jsonb_array_length(spec.source_refs)=1
          AND spec.source_refs->0->>'sourceId'=source.id::text AND spec.source_refs->0->>'version'=source.version::text
          AND (spec.source_refs->0->>'page')::int=${b.physicalPage}
          AND source.id=ANY(attempt.source_ids) AND source.id=ANY(session.source_ids) AND source.id=ANY(activity.source_ids)
          AND attempt.source_versions->>source.id::text=source.version::text
          AND source.name=${b.sourceFile} AND source.version=${b.sourceVersion} AND source.sha256=${b.sourceSha256}
          AND source.upload_state='uploaded' AND source.parse_state='ready'
          AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions exclusion
            WHERE exclusion.workspace_id=source.workspace_id AND exclusion.source_id=source.id)
          AND EXISTS (SELECT 1 FROM opening_source_chunks chunk WHERE chunk.source_id=source.id AND chunk.source_version=source.version AND chunk.page=${b.physicalPage}
            AND (spec.source_refs->0->>'chunkId' IS NULL OR chunk.id::text=spec.source_refs->0->>'chunkId'))`;
      // Duplicate block IDs/multiple matches are ambiguous, not authority.
      if (rows.length !== 1) return null;
      const answer = answerText(rows[0]!);
      return answer ? { postAttemptNotes: null, answer } : null;
    },
  };
}
