import type { Sql, TransactionSql } from "postgres";
import { contextSourceRefsIncluded, noteContextSourceRefs } from "./opening-context-provenance";
import type { OpeningBackupRecordSnapshot } from "./opening-backup-records";
import { backupPrivateLibrary } from "./backup-private-library";
import { asObject } from "./backup-map";
import { withPublicationCardSourceIds } from "./card-sources";
import { historicalTeachingDocumentsByCard, parseBackupSourceRefs, publicationAnswerKeysByDocument, publicationMetadata, publicationMetadataIds, publicationSourceRefsByDocument } from "./backup-publication-provenance";

type Tables = OpeningBackupRecordSnapshot["tables"];
type LibraryTables = Partial<Record<string, Record<string, unknown>[]>>;

function privateTeachingBlockIds(tables: LibraryTables) {
  return [...publicationAnswerKeysByDocument(tables.opening_teaching_activity_specs ?? [], tables.opening_note_provenance ?? []).values()].flat();
}

export function readBackupNoteProvenance(sql: Sql | TransactionSql, workspace: string) {
  return sql`SELECT document_id,workspace_id,context_source_refs,created_at
    FROM opening_note_provenance WHERE workspace_id=${workspace} ORDER BY document_id`;
}

export function excludedTeachingDocumentIds(specs: Record<string, unknown>[], sources: ReadonlySet<string>): string[] {
  return specs.flatMap(spec => typeof spec.document_id === "string" &&
    (!Array.isArray(spec.source_refs) || spec.source_refs.some(ref => {
      const source = asObject(ref)?.sourceId;
      return typeof source !== "string" || !sources.has(source.toLowerCase());
    })) ? [spec.document_id] : []);
}

export function readBackupTeachingSourceRefs(sql: Sql | TransactionSql, workspace: string) {
  return sql`SELECT spec.document_id,spec.source_refs,spec.block_order FROM opening_teaching_activity_specs spec
    JOIN library_documents d ON d.id=spec.document_id
    WHERE spec.workspace_id=${workspace} AND d.workspace_id=${workspace}`;
}

/** Portable automatic cards retain publication lineage even after the spec is detached. */
export function projectOpeningBackupCardSources(tables: LibraryTables, allProvenance = tables.opening_note_provenance ?? []) {
  const observations = new Map((tables.opening_learning_observations ?? []).map(row => [row.id, row.activity_id]));
  const specs = tables.opening_teaching_activity_specs ?? [];
  const documentByActivity = new Map(specs.map(row => [row.activity_id, row.document_id]));
  const sourcesByDocument = new Map<string, Set<string>>();
  function addSources(document: unknown, refs: unknown, historical: boolean) {
    if (typeof document !== "string" || !Array.isArray(refs)) return;
    const id = document.toLowerCase();
    const sources = sourcesByDocument.get(id) ?? new Set<string>();
    for (const value of refs) {
      const ref = asObject(value);
      if (typeof ref?.sourceId === "string" && (!historical || ref.publication === true)) sources.add(ref.sourceId.toLowerCase());
    }
    sourcesByDocument.set(id, sources);
  }
  for (const row of specs) addSources(row.document_id, row.source_refs, false);
  for (const row of allProvenance) addSources(row.document_id, row.context_source_refs, true);
  const historicalDocuments = historicalTeachingDocumentsByCard(allProvenance);
  const includedDocuments = tables.library_documents && new Set(tables.library_documents.filter(row => row.deleted_at == null)
    .map(row => String(row.id).toLowerCase()));
  const includedSources = new Set((tables.opening_sources ?? []).map(row => String(row.id).toLowerCase()));
  return (tables.cards ?? []).flatMap(card => {
    const historical = card.origin_observation_root_id == null ? [] : historicalDocuments.get(String(card.id).toLowerCase()) ?? [];
    const documents = [...historical,
      documentByActivity.get(observations.get(card.origin_observation_root_id)), card.source_document_id]
      .filter((id): id is string => typeof id === "string").map(id => id.toLowerCase());
    if (includedDocuments && documents.some(document => !includedDocuments.has(document))) return [];
    const sourceIds = documents.flatMap(document => [...(sourcesByDocument.get(document) ?? [])]);
    if (sourceIds.some(id => !includedSources.has(id))) return [];
    return [sourceIds.length ? { ...card, source_ids: withPublicationCardSourceIds(card.source_ids, sourceIds) } : card];
  });
}

export function projectOpeningBackupProvenance(rows: Record<string, unknown>[], cardIds: ReadonlySet<unknown>) {
  return rows.map(row => {
    const refs = parseBackupSourceRefs(row.context_source_refs);
    if (!refs) return row;
    const answers = publicationMetadataIds(row.context_source_refs, "answerKeyBlockIds");
    const cards = publicationMetadataIds(row.context_source_refs, "publicationCardIds").filter(id => cardIds.has(id));
    return { ...row, context_source_refs: [
      ...refs, ...publicationMetadata(answers, cards),
    ] };
  });
}

export async function readBackupLibrarySourceVersions(sql: Sql | TransactionSql, workspace: string): Promise<Map<string, number>> {
  const rows = await sql<{ id: string; version: number }[]>`SELECT s.id, s.version FROM opening_sources s WHERE s.workspace_id=${workspace} AND s.upload_state='uploaded'
    AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${workspace} AND e.source_id=s.id)`;
  return new Map(rows.map(row => [row.id, row.version]));
}

function projectTeachingBlockOrder(row: Record<string, unknown>, blockAllowed: (block: Record<string, unknown>) => boolean) {
  return Array.isArray(row.block_order) ? { ...row, block_order: row.block_order.filter(ref => {
    const block = asObject(ref);
    return !block || blockAllowed({ ...block, id: block.blockId });
  }) } : row;
}

function withOpeningPublicationProvenance(tables: LibraryTables) {
  const provenance = new Map((tables.opening_note_provenance ?? []).map(row => [String(row.document_id).toLowerCase(), row]));
  const docs = new Map((tables.library_documents ?? []).map(row => [String(row.id).toLowerCase(), row]));
  const specs = tables.opening_teaching_activity_specs ?? [];
  const sources = new Map((tables.opening_sources ?? []).map(row => [String(row.id).toLowerCase(), Number(row.version)]));
  const publications = publicationSourceRefsByDocument(specs, sources);
  const answerKeys = publicationAnswerKeysByDocument(specs, [...provenance.values()]);
  for (const id of new Set([...publications.keys(), ...answerKeys.keys()])) {
    const document = docs.get(id);
    const refs = publications.get(id) ?? [];
    const answers = answerKeys.get(id) ?? [];
    if (!document || (!refs.length && !answers.length)) continue;
    const row = provenance.get(id) ?? { document_id: document.id, workspace_id: document.workspace_id, context_source_refs: [] };
    if (!Array.isArray(row.context_source_refs)) continue;
    const combined = parseBackupSourceRefs([...row.context_source_refs, ...refs]);
    if (combined) provenance.set(id, { ...row, context_source_refs: [
      ...combined, ...publicationMetadata(answers, publicationMetadataIds(row.context_source_refs, "publicationCardIds")),
    ] });
  }
  return [...provenance.values()];
}

export function projectOpeningRestoreLibrary<T extends LibraryTables>(tables: T): T {
  // Missing inventory has separate legacy recovery semantics.
  if (tables.library_documents === undefined) return tables;
  const provenanceRows = withOpeningPublicationProvenance(tables);
  const library = backupPrivateLibrary(tables.library_documents, tables.library_blocks ?? [], tables.library_revisions ?? [],
    "document_id", [], privateTeachingBlockIds({ ...tables, opening_note_provenance: provenanceRows }));
  return { ...tables,
    library_documents: library.documents,
    ...(tables.library_blocks && { library_blocks: library.blocks }),
    ...(tables.library_revisions && { library_revisions: library.revisions }),
    ...(tables.library_relations && { library_relations: tables.library_relations.filter(row =>
      library.assetAllowed(row.from_id) && library.assetAllowed(row.to_id)) }),
    ...(tables.library_properties && { library_properties: tables.library_properties.filter(row => library.assetAllowed(row.subject_id)) }),
    ...(provenanceRows.length > 0 && { opening_note_provenance: provenanceRows.filter(row => library.documentAllowed(row.document_id)) }),
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
export async function readBackupLibrary(tx: TransactionSql, workspace: string, tables: Tables, privateExams: string[],
  provenance: Record<string, unknown>[]) {
  const sourceIds = new Set(tables.opening_sources.map(row => String(row.id)));
  const excludedDocuments = [...privateExams, ...excludedTeachingDocumentIds(tables.opening_teaching_activity_specs, sourceIds)];
  const documents = [...await tx`SELECT d.id,d.workspace_id,d.title,d.lifecycle,d.schema_version,d.current_revision_number,
      d.created_at,d.updated_at,d.deleted_at FROM library_documents d
    WHERE d.workspace_id=${workspace} AND NOT (d.id=ANY(${excludedDocuments}::uuid[]))
      AND NOT EXISTS (SELECT 1 FROM opening_note_provenance p WHERE p.document_id=d.id AND
        (p.workspace_id<>d.workspace_id OR NOT (${contextSourceRefsIncluded(tx, workspace, noteContextSourceRefs(tx, tx`p.context_source_refs`), true)})))
      AND NOT EXISTS (SELECT 1 FROM opening_teaching_units u WHERE u.document_id=d.id
        AND NOT (u.id=ANY(${tables.opening_teaching_units.map(row => String(row.id))}::uuid[])))
      AND NOT EXISTS (SELECT 1 FROM opening_teaching_activity_specs spec WHERE spec.document_id=d.id
        AND NOT (spec.id=ANY(${tables.opening_teaching_activity_specs.map(row => String(row.id))}::uuid[])))
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
  const library = backupPrivateLibrary(documents, blocks, revisions, "document_id", [],
    privateTeachingBlockIds({ ...tables, opening_note_provenance: provenance }), sourceIds);
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
  const documentsIncluded = new Set(ids);
  tables.opening_teaching_units = tables.opening_teaching_units.filter(row => documentsIncluded.has(String(row.document_id)));
  const units = new Set(tables.opening_teaching_units.map(row => row.id));
  const specs = tables.opening_teaching_activity_specs.filter(row => documentsIncluded.has(String(row.document_id)) && units.has(row.teaching_unit_id));
  tables.opening_teaching_activity_specs = specs.map(row => projectTeachingBlockOrder(row, library.blockAllowed));
  return { library_documents: library.documents, library_blocks: library.blocks, library_revisions: library.revisions,
    library_relations: relations, library_properties: properties,
    opening_note_provenance: withOpeningPublicationProvenance({
      library_documents: library.documents, opening_teaching_activity_specs: specs, opening_sources: tables.opening_sources,
      opening_note_provenance: provenance.filter(row => documentsIncluded.has(String(row.document_id))),
    }) };
}
