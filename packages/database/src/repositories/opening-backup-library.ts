import type { TransactionSql } from "postgres";
import { contextSourceRefsIncluded } from "./opening-context-provenance";
import type { OpeningBackupRecordSnapshot } from "./opening-backup-records";

type Tables = OpeningBackupRecordSnapshot["tables"];

/** The same historical lineage predicate used by native note export. Child objects follow
 * admitted document and block identities, including both ends of polymorphic relations. */
export async function readBackupLibrary(tx: TransactionSql, workspace: string, tables: Tables) {
  const documents = [...await tx`SELECT d.id,d.workspace_id,d.title,d.lifecycle,d.schema_version,d.current_revision_number,
      d.created_at,d.updated_at,d.deleted_at FROM library_documents d
    WHERE d.workspace_id=${workspace}
      AND NOT EXISTS (SELECT 1 FROM opening_note_provenance p WHERE p.document_id=d.id AND
        (p.workspace_id<>d.workspace_id OR NOT (${contextSourceRefsIncluded(tx, workspace, tx`p.context_source_refs`, true)})))
      AND NOT EXISTS (SELECT 1 FROM opening_teaching_units u WHERE u.document_id=d.id
        AND NOT (u.id=ANY(${tables.opening_teaching_units.map(row => String(row.id))}::uuid[])))
      AND NOT EXISTS (SELECT 1 FROM opening_teaching_activity_specs spec WHERE spec.document_id=d.id
        AND NOT (spec.id=ANY(${tables.opening_teaching_activity_specs.map(row => String(row.id))}::uuid[])))
      AND NOT EXISTS (SELECT 1 FROM opening_teaching_activity_specs spec
        CROSS JOIN LATERAL jsonb_array_elements(spec.source_refs) ref WHERE spec.document_id=d.id
        AND ((ref->>'sourceId')=ANY(${tables.opening_sources.map(row => String(row.id))}::text[])) IS NOT TRUE)
      AND NOT EXISTS (SELECT 1 FROM opening_teaching_units u
        JOIN opening_exam_sprints s ON s.workspace_id=u.workspace_id AND s.owner_user_id=u.owner_user_id
        CROSS JOIN LATERAL jsonb_array_elements(s.pack_snapshot->'requests') req
        WHERE u.document_id=d.id AND req->>'id'=u.generation_config->'extras'->>'requestId'
          AND ((req->'input'->>'sourceId')=ANY(${tables.opening_sources.map(row => String(row.id))}::text[])) IS NOT TRUE)
    ORDER BY d.id`];
  const ids = documents.map(row => String(row.id));
  const blocks = [...await tx`SELECT b.id,b.workspace_id,b.document_id,b.type,b.position,b.content,b.created_at,b.updated_at
    FROM library_blocks b WHERE b.workspace_id=${workspace} AND b.document_id=ANY(${ids}::uuid[]) ORDER BY b.id`];
  const blockIds = blocks.map(row => String(row.id));
  const revisions = [...await tx`SELECT r.id,r.workspace_id,r.document_id,r.revision_number,r.parent_revision_number,
      r.title,r.lifecycle,r.reason,r.blocks,r.created_at FROM library_revisions r
    WHERE r.workspace_id=${workspace} AND r.document_id=ANY(${ids}::uuid[]) ORDER BY r.document_id,r.revision_number`];
  const relations = [...await tx`SELECT id,workspace_id,from_type,from_id,to_type,to_id,relation_type,created_at,source
    FROM library_relations WHERE workspace_id=${workspace}
      AND ((from_type='document' AND from_id=ANY(${ids}::uuid[])) OR (from_type='block' AND from_id=ANY(${blockIds}::uuid[])))
      AND ((to_type='document' AND to_id=ANY(${ids}::uuid[])) OR (to_type='block' AND to_id=ANY(${blockIds}::uuid[])))
    ORDER BY id`];
  const properties = [...await tx`SELECT id,workspace_id,subject_type,subject_id,key,value_type,value,created_at,updated_at
    FROM library_properties WHERE workspace_id=${workspace}
      AND ((subject_type='document' AND subject_id=ANY(${ids}::uuid[])) OR (subject_type='block' AND subject_id=ANY(${blockIds}::uuid[])))
    ORDER BY id`];
  const provenance = [...await tx`SELECT document_id,workspace_id,context_source_refs,created_at
    FROM opening_note_provenance WHERE workspace_id=${workspace} AND document_id=ANY(${ids}::uuid[]) ORDER BY document_id`];
  // Teaching revisions can retain an answer after its live block was edited away.
  // Keep block identities for published specs; their plaintext stays server-side.
  const teachingDocs = new Set(tables.opening_teaching_units.map(row => row.document_id));
  const hidden = new Set<unknown>();
  for (const spec of tables.opening_teaching_activity_specs) {
    if (Array.isArray(spec.block_order)) for (const ref of spec.block_order) {
      if (ref?.role === "answer_key" || ref?.blockType === "solution" || ref?.blockType === "answer_key") hidden.add(ref.blockId);
    }
  }
  const projectBlock = (block: Record<string, unknown>) => hidden.has(block.id) || block.type === "answer_key" || block.type === "solution"
    ? { ...block, content: {} } : block;
  for (const block of blocks) if (teachingDocs.has(block.document_id)) Object.assign(block, projectBlock(block));
  for (const revision of revisions) if (teachingDocs.has(revision.document_id) && Array.isArray(revision.blocks)) {
    revision.blocks = revision.blocks.map(projectBlock);
  }
  const documentsIncluded = new Set(ids);
  tables.opening_teaching_units = tables.opening_teaching_units.filter(row => documentsIncluded.has(String(row.document_id)));
  const units = new Set(tables.opening_teaching_units.map(row => row.id));
  tables.opening_teaching_activity_specs = tables.opening_teaching_activity_specs.filter(row =>
    documentsIncluded.has(String(row.document_id)) && units.has(row.teaching_unit_id));
  return { library_documents: documents, library_blocks: blocks, library_revisions: revisions,
    library_relations: relations, library_properties: properties, opening_note_provenance: provenance };
}
