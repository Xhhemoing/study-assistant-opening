import type { Sql, TransactionSql } from "postgres";
import { contextSourceRefsIncluded } from "./opening-context-provenance";
import type { OpeningBackupRecordSnapshot } from "./opening-backup-records";
import { backupPrivateLibrary, isBackupAnswerBlock } from "./backup-private-library";
import { asObject } from "./backup-map";

type Tables = OpeningBackupRecordSnapshot["tables"];
type LibraryTables = Partial<Record<string, Record<string, unknown>[]>>;

function privateTeachingBlockIds(tables: LibraryTables) {
  return (tables.opening_teaching_activity_specs ?? []).flatMap(row => Array.isArray(row.block_order)
    ? row.block_order.flatMap(ref => {
      const block = asObject(ref);
      return block && isBackupAnswerBlock(block) ? [block.blockId] : [];
    }) : []);
}

export async function readBackupAnswerBlockIds(sql: Sql | TransactionSql, workspace: string): Promise<unknown[]> {
  const specs = await sql`SELECT block_order FROM opening_teaching_activity_specs WHERE workspace_id=${workspace}`;
  return privateTeachingBlockIds({ opening_teaching_activity_specs: specs });
}

export async function readBackupLibrarySourceIds(sql: Sql | TransactionSql, workspace: string): Promise<Set<string>> {
  const rows = await sql`SELECT s.id FROM opening_sources s WHERE s.workspace_id=${workspace} AND s.upload_state='uploaded'
    AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${workspace} AND e.source_id=s.id)`;
  return new Set(rows.map(row => String(row.id)));
}

function projectTeachingBlockOrder(row: Record<string, unknown>, blockAllowed: (block: Record<string, unknown>) => boolean) {
  return Array.isArray(row.block_order) ? { ...row, block_order: row.block_order.filter(ref => {
    const block = asObject(ref);
    return !block || blockAllowed({ ...block, id: block.blockId });
  }) } : row;
}

export function projectOpeningRestoreLibrary<T extends LibraryTables>(tables: T): T {
  // Missing inventory has separate legacy recovery semantics.
  if (tables.library_documents === undefined) return tables;
  const library = backupPrivateLibrary(tables.library_documents, tables.library_blocks ?? [], tables.library_revisions ?? [],
    "document_id", [], privateTeachingBlockIds(tables));
  return { ...tables,
    library_documents: library.documents,
    ...(tables.library_blocks && { library_blocks: library.blocks }),
    ...(tables.library_revisions && { library_revisions: library.revisions }),
    ...(tables.library_relations && { library_relations: tables.library_relations.filter(row =>
      library.assetAllowed(row.from_id) && library.assetAllowed(row.to_id)) }),
    ...(tables.library_properties && { library_properties: tables.library_properties.filter(row => library.assetAllowed(row.subject_id)) }),
    ...(tables.opening_note_provenance && { opening_note_provenance: tables.opening_note_provenance.filter(row => library.documentAllowed(row.document_id)) }),
    ...(tables.opening_teaching_activity_specs && { opening_teaching_activity_specs: tables.opening_teaching_activity_specs.map(row =>
      projectTeachingBlockOrder(row, library.blockAllowed)) }),
  };
}

/** The caller's teaching activity is aliased as a in both inventory queries. */
function isGeneratedExamActivity(sql: Sql | TransactionSql) {
  return sql`(a.create_intent->>'kind' IS NOT DISTINCT FROM 'course_exam'
    OR EXISTS (SELECT 1 FROM opening_exam_sprints s WHERE s.workspace_id=a.workspace_id
      AND s.owner_user_id=a.owner_user_id AND s.course_id=a.course_id
      AND s.pack_snapshot @> jsonb_build_object('requests',jsonb_build_array(jsonb_build_object('activityId',a.id::text)))))`;
}

/** A generated exam cannot be republished without the original private proposal.
 * Exclude its entire document, including old revisions and unlabelled answer text. */
export async function privateExamDocumentIds(sql: Sql | TransactionSql, workspace: string): Promise<string[]> {
  const rows = await sql`SELECT u.document_id FROM opening_teaching_units u
    WHERE u.workspace_id=${workspace} AND u.generation_config #>> '{extras,kind}'='course_exam'
    UNION
    SELECT spec.document_id FROM opening_teaching_activity_specs spec
    JOIN opening_teaching_activities a ON a.id=spec.activity_id AND a.workspace_id=spec.workspace_id
    WHERE spec.workspace_id=${workspace} AND (spec.generation_config #>> '{extras,kind}'='course_exam'
      OR ${isGeneratedExamActivity(sql)})`;
  return rows.map(row => String(row.document_id));
}

export function isPrivateExamActivity(sql: Sql | TransactionSql, privateExams: string[]) {
  return sql`(${isGeneratedExamActivity(sql)} OR EXISTS (SELECT 1 FROM opening_teaching_activity_specs spec
    JOIN opening_teaching_units unit ON unit.id=spec.teaching_unit_id
    WHERE spec.workspace_id=a.workspace_id AND spec.activity_id=a.id
      AND (spec.document_id=ANY(${privateExams}::uuid[]) OR unit.document_id=ANY(${privateExams}::uuid[]))))`;
}

/** The same historical lineage predicate used by native note export. Child objects follow
 * admitted document and block identities, including both ends of polymorphic relations. */
export async function readBackupLibrary(tx: TransactionSql, workspace: string, tables: Tables, privateExams: string[]) {
  const documents = [...await tx`SELECT d.id,d.workspace_id,d.title,d.lifecycle,d.schema_version,d.current_revision_number,
      d.created_at,d.updated_at,d.deleted_at FROM library_documents d
    WHERE d.workspace_id=${workspace} AND NOT (d.id=ANY(${privateExams}::uuid[]))
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
  const candidateIds = documents.map(row => String(row.id));
  const blocks = [...await tx`SELECT b.id,b.workspace_id,b.document_id,b.type,b.position,b.content,b.created_at,b.updated_at
    FROM library_blocks b WHERE b.workspace_id=${workspace} AND b.document_id=ANY(${candidateIds}::uuid[]) ORDER BY b.id`];
  const revisions = [...await tx`SELECT r.id,r.workspace_id,r.document_id,r.revision_number,r.parent_revision_number,
      r.title,r.lifecycle,r.reason,r.blocks,r.created_at FROM library_revisions r
    WHERE r.workspace_id=${workspace} AND r.document_id=ANY(${candidateIds}::uuid[]) ORDER BY r.document_id,r.revision_number`];
  const sourceIds = new Set(tables.opening_sources.map(row => String(row.id)));
  const library = backupPrivateLibrary(documents, blocks, revisions, "document_id", [], privateTeachingBlockIds(tables), sourceIds);
  const ids = library.documents.map(row => String(row.id));
  const blockIds = library.blocks.map(row => String(row.id));
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
  const documentsIncluded = new Set(ids);
  tables.opening_teaching_units = tables.opening_teaching_units.filter(row => documentsIncluded.has(String(row.document_id)));
  const units = new Set(tables.opening_teaching_units.map(row => row.id));
  tables.opening_teaching_activity_specs = tables.opening_teaching_activity_specs.filter(row =>
    documentsIncluded.has(String(row.document_id)) && units.has(row.teaching_unit_id)).map(row => projectTeachingBlockOrder(row, library.blockAllowed));
  return { library_documents: library.documents, library_blocks: library.blocks, library_revisions: library.revisions,
    library_relations: relations, library_properties: properties, opening_note_provenance: provenance };
}
