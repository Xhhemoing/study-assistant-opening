import { cardReadable, cardSourcesIncluded, notePublicationCardIds } from "./card-sources";
import { uuidSchema } from "@aistudy/contracts";
import { notePublicationMetadata, type ExistingBackupIds } from "@aistudy/domain";
import type { Sql } from "postgres";
import type { NativeBackupPackage } from "@aistudy/contracts";
import { retainBackupEventChains, type NativeBackupSnapshot, type NativeBackupRecord } from "@aistudy/domain/native";
import {
  isMemoryDependencyMetadata,
  isVerifiedSnippetLineage,
  lineageUuid,
  memoryOnlyRefSourceIds,
  noteContextSourceRefsIncluded,
  noteOriginTurnIds,
  openingCredentialMemoriesAvailable,
  openingSnippetOriginsAvailable,
  parseNoteContextProvenanceRefs,
} from "./opening-context-provenance";
import { BackupRestoreError } from "./backup-types";
import { asRecords, filesFromBlocks } from "./backup-map";
import { backupPrivateLibrary } from "./backup-private-library";
import { attachNativeCardPublicationSources } from "./native-backup-teaching";
import { readBackupLibrarySourceVersions } from "./opening-backup-library";
import {
  canonicalNoteProvenanceEntries,
  mergeNotePublicationProvenance,
  parseBackupSourceRefs,
  type BackupSourceRef,
} from "./backup-publication-provenance";

export type NoteBackupProvenance = {
  contextSourceRefs: BackupSourceRef[];
  answerKeyBlockIds?: string[];
  memoryDependencyIds?: string[];
  originTurnIds?: string[];
  snippetLineageVersion?: 1;
};

const ALLOWED_NOTE_BACKUP_PROVENANCE_KEYS = new Set([
  "contextSourceRefs",
  "answerKeyBlockIds",
  "memoryDependencyIds",
  "originTurnIds",
  "snippetLineageVersion",
]);

/** Remove the whole linked note, including historical text and native dependants. */
export function filterNativeNotes(snapshot: NativeBackupSnapshot, provenance: ReadonlyMap<string, NoteBackupProvenance | null>,
  privateCards: ReadonlySet<string> = new Set()): NativeBackupSnapshot {
  const normalizedProvenance = new Map([...provenance].map(([id, value]) => [id.toLowerCase(), value]));
  const normalizedPrivateCards = new Set([...privateCards].map(id => id.toLowerCase()));
  const isBlockedDoc = (id: unknown) => typeof id === "string" && normalizedProvenance.get(id.toLowerCase()) === null;
  const blockedDocs = new Set([...normalizedProvenance].filter(([, value]) => value === null).map(([id]) => id));
  const blockedBlocks = new Set(snapshot.blocks.filter(row => isBlockedDoc(row.documentId)).map(row => row.id.toLowerCase()));
  const blockedCards = new Set(snapshot.cards.filter(row => normalizedPrivateCards.has(row.id.toLowerCase()) || isBlockedDoc(row.sourceDocumentId)
    || Array.isArray(row.originTeachingDocumentIds) && row.originTeachingDocumentIds.some(id => isBlockedDoc(id))).map(row => row.id.toLowerCase()));
  const blocked = new Set([...blockedDocs, ...blockedBlocks, ...blockedCards]);
  const isBlockedAsset = (id: unknown) => typeof id === "string" && (blocked.has(id) || blocked.has(id.toLowerCase()));
  const blocks = snapshot.blocks.filter(row => !isBlockedDoc(row.documentId));
  return {
    ...snapshot,
    documents: snapshot.documents.filter(row => !isBlockedDoc(row.id)).map(row => ({
      ...row,
      openingProvenance: provenance.get(row.id) ?? normalizedProvenance.get(row.id.toLowerCase()) ?? null,
    })),
    blocks,
    revisions: snapshot.revisions.filter(row => !isBlockedDoc(row.documentId)),
    relations: snapshot.relations.filter(row => !isBlockedAsset(row.fromId) && !isBlockedAsset(row.toId)),
    memberships: snapshot.memberships.filter(row => row.assetType !== "source" && !isBlockedAsset(row.assetId)),
    cards: snapshot.cards.filter(row => !blockedCards.has(row.id.toLowerCase())),
    events: retainBackupEventChains(snapshot.events.filter(row => !isBlockedAsset(row.contentId)), "correctsEventId"),
    promotions: snapshot.promotions.filter(row => !isBlockedAsset(row.targetId)).map(row => Array.isArray(row.targets)
      ? { ...row, targets: row.targets.filter(target => !isBlockedAsset(target?.targetId)) } : row),
    files: filesFromBlocks(blocks),
  };
}

export async function applyNativeNoteExportPrivacy(sql: Sql, workspaceId: string, snapshot: NativeBackupSnapshot,
  publications: ReadonlyMap<string, BackupSourceRef[]>, answerKeys: ReadonlyMap<string, string[]>): Promise<NativeBackupSnapshot> {
  const rows = await sql`SELECT p.document_id, p.context_source_refs,
    (p.workspace_id=${workspaceId} AND ${noteContextSourceRefsIncluded(sql, workspaceId, () => sql`p.context_source_refs`, true)}) AS included
    FROM opening_note_provenance p
    WHERE p.workspace_id=${workspaceId}
      OR EXISTS (SELECT 1 FROM library_documents d WHERE d.id=p.document_id AND d.workspace_id=${workspaceId})`;
  const provenance = new Map<string, NoteBackupProvenance | null>();
  const note = (
    id: string,
    refs: BackupSourceRef[],
    lineage?: { memoryDependencyIds?: string[]; originTurnIds?: string[]; snippetLineageVersion?: 1 },
  ): NoteBackupProvenance => ({
    contextSourceRefs: refs,
    ...(answerKeys.has(id) && { answerKeyBlockIds: answerKeys.get(id) }),
    ...(lineage?.memoryDependencyIds?.length ? { memoryDependencyIds: lineage.memoryDependencyIds } : {}),
    ...(lineage?.originTurnIds?.length ? { originTurnIds: lineage.originTurnIds } : {}),
    ...(lineage?.snippetLineageVersion === 1 ? { snippetLineageVersion: 1 as const } : {}),
  });
  for (const id of new Set([...publications.keys(), ...answerKeys.keys()])) {
    const refs = parseBackupSourceRefs(publications.get(id) ?? []);
    if (refs?.length || answerKeys.has(id)) provenance.set(id, refs ? note(id, refs) : null);
  }
  let ownerScope: { workspaceId: string; ownerUserId: string } | null | undefined;
  const getOwnerScope = async () => {
    if (ownerScope !== undefined) return ownerScope;
    const [ws] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${workspaceId}`;
    ownerScope = typeof ws?.owner_user_id === "string" ? { workspaceId, ownerUserId: ws.owner_user_id } : null;
    return ownerScope;
  };
  for (const row of rows) {
    const id = String(row.document_id).toLowerCase();
    const provenanceRefs = parseNoteContextProvenanceRefs(row.context_source_refs);
    const refs = Array.isArray(row.context_source_refs) && provenanceRefs !== null
      ? parseBackupSourceRefs([...row.context_source_refs, ...(publications.get(id) ?? [])]) : null;
    if (!row.included || provenanceRefs === null || refs === null) {
      provenance.set(id, null);
      continue;
    }
    const memoryDependencyIds = provenanceRefs.find(ref => "memoryDependencyIds" in ref)?.memoryDependencyIds ?? [];
    const originTurnIds = noteOriginTurnIds(row.context_source_refs);
    const backingSourceIds = memoryOnlyRefSourceIds(provenanceRefs);
    const snippetLineageVersion = Array.isArray(row.context_source_refs) && row.context_source_refs.some(isVerifiedSnippetLineage)
      ? 1 as const : undefined;
    if (memoryDependencyIds.length > 0 || originTurnIds.length > 0 || backingSourceIds.length > 0) {
      const scope = await getOwnerScope();
      if (!scope
        || !await openingSnippetOriginsAvailable(sql, scope, originTurnIds)
        || !await openingCredentialMemoriesAvailable(sql, scope, memoryDependencyIds, backingSourceIds)) {
        provenance.set(id, null);
        continue;
      }
    }
    provenance.set(id, note(id, refs, { memoryDependencyIds, originTurnIds, snippetLineageVersion }));
  }
  const blockedCards = new Set((await sql`SELECT c.id FROM cards c WHERE c.workspace_id=${workspaceId}
    AND NOT (${cardReadable(sql, workspaceId)})`).map(row => String(row.id)));
  const admitted = filterNativeNotes(snapshot, provenance, blockedCards);
  const sourcesByDocument = new Map([...provenance].map(([id, value]) => [id, value?.contextSourceRefs ?? []]));
  return { ...admitted, cards: attachNativeCardPublicationSources(admitted.cards, sourcesByDocument) };
}

/** Null denotes an ordinary note; absent metadata is only compatible with pre-0035 archives. */
export function readNoteBackupProvenance(record: NativeBackupRecord, requiresMetadata: boolean): NoteBackupProvenance | null {
  if (!Object.hasOwn(record, "openingProvenance")) {
    if (requiresMetadata) throw new BackupRestoreError("VALIDATION", "Backup note provenance is missing");
    return null;
  }
  if (record.openingProvenance === null) return null;
  const value = record.openingProvenance;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BackupRestoreError("VALIDATION", "Backup note provenance is invalid");
  const recordValue = value as Record<string, unknown>;
  if (Object.keys(recordValue).some(key => !ALLOWED_NOTE_BACKUP_PROVENANCE_KEYS.has(key))) {
    throw new BackupRestoreError("VALIDATION", "Backup note provenance has unknown properties");
  }
  const {
    contextSourceRefs,
    answerKeyBlockIds,
    memoryDependencyIds,
    originTurnIds,
    snippetLineageVersion,
  } = recordValue;
  if (!Array.isArray(contextSourceRefs)
    || contextSourceRefs.some(ref => notePublicationMetadata(ref) !== null || isMemoryDependencyMetadata(ref))) {
    throw new BackupRestoreError("VALIDATION", "Backup note provenance is unknown");
  }
  const refs = parseBackupSourceRefs(contextSourceRefs);
  if (refs === null) throw new BackupRestoreError("VALIDATION", "Backup note provenance is unknown");
  if (answerKeyBlockIds !== undefined && (!Array.isArray(answerKeyBlockIds) || !answerKeyBlockIds.every(id => uuidSchema.safeParse(id).success))) {
    throw new BackupRestoreError("VALIDATION", "Backup answer-key block identities are invalid");
  }
  if (memoryDependencyIds !== undefined && (!Array.isArray(memoryDependencyIds)
    || memoryDependencyIds.length === 0
    || !memoryDependencyIds.every(id => uuidSchema.safeParse(id).success))) {
    throw new BackupRestoreError("VALIDATION", "Backup note memory dependencies are invalid");
  }
  if (originTurnIds !== undefined && (!Array.isArray(originTurnIds)
    || originTurnIds.length === 0
    || !originTurnIds.every(id => uuidSchema.safeParse(id).success))) {
    throw new BackupRestoreError("VALIDATION", "Backup note origin turns are invalid");
  }
  if (snippetLineageVersion !== undefined && snippetLineageVersion !== 1) {
    throw new BackupRestoreError("VALIDATION", "Backup note snippet lineage version is invalid");
  }
  return {
    contextSourceRefs: refs,
    ...(Array.isArray(answerKeyBlockIds) && {
      answerKeyBlockIds: [...new Set(answerKeyBlockIds.map(id => String(id).toLowerCase()))],
    }),
    ...(Array.isArray(memoryDependencyIds) && {
      memoryDependencyIds: [...new Set(memoryDependencyIds.map(id => String(id).toLowerCase()))].sort(),
    }),
    ...(Array.isArray(originTurnIds) && {
      originTurnIds: [...new Set(originTurnIds.map(id => String(id).toLowerCase()))].sort(),
    }),
    ...(snippetLineageVersion === 1 && { snippetLineageVersion: 1 as const }),
  };
}

export async function assertNativeNoteRestorePrivacy(sql: Sql, workspaceId: string, packed: NativeBackupPackage): Promise<void> {
  const modern = Number.parseInt(packed.schemaManifest.latestMigrationId.slice(0, 4), 10) >= 35;
  const normalizedWorkspaceId = workspaceId.toLowerCase();
  const sameWorkspace = packed.sourceWorkspaceId.toLowerCase() === normalizedWorkspaceId;
  const addUuid = (ids: Set<string>, value: unknown) => {
    if (typeof value === "string" && uuidSchema.safeParse(value).success) ids.add(value.toLowerCase());
  };
  const documentIds = new Set<string>();
  const incomingActiveDocIds = new Set<string>();
  const incomingRevisionDocById = new Map<string, string>();
  const blockCandidateIds = new Set<string>();
  const cardCandidateIds = new Set<string>();
  const eventCandidateIds = new Set<string>();
  for (const row of asRecords(packed.records.documents)) {
    addUuid(documentIds, row.id);
    if (row.deletedAt == null && uuidSchema.safeParse(row.id).success) {
      incomingActiveDocIds.add(row.id.toLowerCase());
    }
  }
  for (const row of asRecords(packed.records.blocks)) {
    addUuid(documentIds, row.documentId);
    addUuid(blockCandidateIds, row.id);
  }
  for (const row of asRecords(packed.records.revisions)) {
    addUuid(documentIds, row.documentId);
    if (uuidSchema.safeParse(row.id).success && typeof row.documentId === "string" && uuidSchema.safeParse(row.documentId).success) {
      incomingRevisionDocById.set(row.id.toLowerCase(), row.documentId.toLowerCase());
    }
  }
  for (const card of asRecords(packed.records.cards)) {
    addUuid(documentIds, card.sourceDocumentId);
    for (const id of teachingDocumentIds(card)) addUuid(documentIds, id);
    addUuid(cardCandidateIds, card.id);
  }
  for (const row of asRecords(packed.records.memberships)) {
    if (row.assetType !== "source") {
      addUuid(documentIds, row.assetId);
      addUuid(blockCandidateIds, row.assetId);
      if (row.assetType === "card") addUuid(cardCandidateIds, row.assetId);
    }
  }
  for (const row of asRecords(packed.records.relations)) {
    addUuid(documentIds, row.fromId);
    addUuid(documentIds, row.toId);
    addUuid(blockCandidateIds, row.fromId);
    addUuid(blockCandidateIds, row.toId);
    if (row.fromType === "card") addUuid(cardCandidateIds, row.fromId);
    if (row.toType === "card") addUuid(cardCandidateIds, row.toId);
  }
  for (const row of asRecords(packed.records.promotions)) {
    addUuid(documentIds, row.targetId);
    addUuid(blockCandidateIds, row.targetId);
    addUuid(cardCandidateIds, row.targetId);
    if (Array.isArray(row.targets)) {
      for (const target of row.targets) {
        if (target && typeof target === "object") {
          const targetId = (target as Record<string, unknown>).targetId;
          addUuid(documentIds, targetId);
          addUuid(blockCandidateIds, targetId);
          addUuid(cardCandidateIds, targetId);
        }
      }
    }
  }
  for (const row of asRecords(packed.records.events)) {
    addUuid(eventCandidateIds, row.id);
    addUuid(eventCandidateIds, row.correctsEventId);
    if (row.type === "review" || row.type === "correction") addUuid(cardCandidateIds, row.contentId);
  }
  if (eventCandidateIds.size > 0) {
    const eventCards = await sql`WITH RECURSIVE event_chain(id, corrects_event_id, content_id) AS (
        SELECT e.id, e.corrects_event_id, e.content_id
        FROM learning_events e
        WHERE e.workspace_id=${workspaceId} AND e.id=ANY(${[...eventCandidateIds]}::uuid[])
        UNION
        SELECT parent.id, parent.corrects_event_id, parent.content_id
        FROM event_chain child
        JOIN learning_events parent
          ON parent.id=child.corrects_event_id AND parent.workspace_id=${workspaceId}
      )
      SELECT DISTINCT content_id FROM event_chain WHERE content_id IS NOT NULL`;
    for (const row of eventCards) addUuid(cardCandidateIds, row.content_id);
  }
  if (blockCandidateIds.size > 0) {
    const blockDocs = await sql`SELECT DISTINCT document_id FROM library_blocks
      WHERE workspace_id=${workspaceId} AND id=ANY(${[...blockCandidateIds]}::uuid[])`;
    for (const row of blockDocs) addUuid(documentIds, row.document_id);
  }
  const retainedTeachingDocIds = new Set<string>();
  if (cardCandidateIds.size > 0) {
    const isExamActivity = (alias: "act" | "pa") => {
      const a = alias === "act" ? sql`act` : sql`pa`;
      return sql`(${a}.create_intent->>'kind' IS NOT DISTINCT FROM 'course_exam'
        OR EXISTS (
          SELECT 1 FROM opening_exam_sprints s
          WHERE s.workspace_id=${a}.workspace_id
            AND s.owner_user_id=${a}.owner_user_id
            AND s.course_id=${a}.course_id
            AND s.pack_snapshot @> jsonb_build_object('requests', jsonb_build_array(jsonb_build_object('activityId', ${a}.id::text)))
        ))`;
    };
    const isDocDisallowedTeaching = (docExpr: () => ReturnType<Sql>) => sql`(
      EXISTS (
        SELECT 1 FROM opening_teaching_units pu
        WHERE pu.workspace_id=${workspaceId} AND pu.document_id=${docExpr()}
          AND pu.generation_config #>> '{extras,kind}'='course_exam'
      )
      OR EXISTS (
        SELECT 1 FROM opening_teaching_activity_specs ts
        LEFT JOIN opening_teaching_units tu ON tu.id=ts.teaching_unit_id AND tu.workspace_id=ts.workspace_id
        LEFT JOIN opening_teaching_activities pa ON pa.id=ts.activity_id AND pa.workspace_id=ts.workspace_id
        WHERE ts.workspace_id=${workspaceId}
          AND (ts.document_id=${docExpr()} OR tu.document_id=${docExpr()})
          AND (
            pa.id IS NULL
            OR ts.generation_config #>> '{extras,kind}'='course_exam'
            OR tu.generation_config #>> '{extras,kind}'='course_exam'
            OR ${isExamActivity("pa")}
            OR NOT (${cardSourcesIncluded(sql, workspaceId, sql`pa.source_ids`)})
            OR jsonb_typeof(ts.source_refs) IS DISTINCT FROM 'array'
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(ts.source_refs)='array' THEN ts.source_refs ELSE '[]'::jsonb END
              ) AS sref
              WHERE jsonb_typeof(sref) IS DISTINCT FROM 'object'
                OR jsonb_typeof(sref->'sourceId') IS DISTINCT FROM 'string'
                OR ${lineageUuid(sql, () => sql`sref->>'sourceId'`)} IS NULL
                OR NOT (${cardSourcesIncluded(sql, workspaceId, sql`ARRAY[${lineageUuid(sql, () => sql`sref->>'sourceId'`)}]`)})
            )
          )
      )
    )`;
    const cardRows = await sql`SELECT
        c.id AS card_id,
        c.source_document_id,
        linked.teaching_doc_id,
        COALESCE(linked.teaching_doc_id, c.source_document_id) AS document_id,
        item.teaching_revision_id,
        (revision.id IS NOT NULL) AS revision_exists,
        (${cardReadable(sql, workspaceId)}) AS card_readable,
        (c.origin_observation_root_id IS NULL OR obs.id IS NOT NULL) AS origin_valid,
        (
          cardinality(c.source_ids) > 0
          OR c.origin_observation_root_id IS NOT NULL
          OR (c.source_document_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM opening_teaching_activity_specs ts
            LEFT JOIN opening_teaching_units tu ON tu.id=ts.teaching_unit_id AND tu.workspace_id=ts.workspace_id
            LEFT JOIN opening_teaching_activities pa ON pa.id=ts.activity_id AND pa.workspace_id=ts.workspace_id
            WHERE ts.workspace_id=${workspaceId}
              AND (ts.document_id=c.source_document_id OR tu.document_id=c.source_document_id)
              AND (cardinality(COALESCE(pa.source_ids, '{}'::uuid[])) > 0 OR ts.source_refs <> '[]'::jsonb)
          ))
        ) AS has_opening_lineage,
        (
          obs.id IS NULL OR (
            ${cardSourcesIncluded(sql, workspaceId, sql`obs.source_ids`)}
            AND (obs.activity_id IS NULL OR (
              act.id IS NOT NULL
              AND ${cardSourcesIncluded(sql, workspaceId, sql`act.source_ids`)}
              AND NOT ${isExamActivity("act")}
            ))
            AND (obs.item_version_id IS NULL OR (
              item.id IS NOT NULL
              AND (item.source_id IS NULL OR ${cardSourcesIncluded(sql, workspaceId, sql`ARRAY[item.source_id]::uuid[]`)})
            ))
          )
        ) AS origin_admitted,
        (c.source_document_id IS NULL OR NOT ${isDocDisallowedTeaching(() => sql`c.source_document_id`)}) AS source_doc_teaching_admitted,
        (linked.teaching_doc_id IS NULL OR (td.id IS NOT NULL AND td.deleted_at IS NULL)) AS teaching_doc_active,
        (linked.teaching_doc_id IS NULL OR NOT ${isDocDisallowedTeaching(() => sql`linked.teaching_doc_id`)}) AS teaching_doc_spec_allowed
      FROM cards c
      LEFT JOIN opening_learning_observations obs
        ON obs.id=c.origin_observation_root_id
        AND obs.workspace_id=c.workspace_id
        AND obs.owner_user_id=c.owner_user_id
        AND COALESCE(obs.root_observation_id, obs.id)=obs.id
      LEFT JOIN opening_teaching_activities act
        ON act.id=obs.activity_id AND act.workspace_id=obs.workspace_id
      LEFT JOIN opening_teaching_activity_specs spec
        ON spec.activity_id=obs.activity_id AND spec.workspace_id=obs.workspace_id
      LEFT JOIN opening_teaching_units unit
        ON unit.id=spec.teaching_unit_id AND unit.workspace_id=obs.workspace_id
      LEFT JOIN opening_learning_item_versions item
        ON item.id=obs.item_version_id AND item.workspace_id=obs.workspace_id
      LEFT JOIN library_revisions revision
        ON revision.id=item.teaching_revision_id AND revision.workspace_id=obs.workspace_id
      LEFT JOIN LATERAL (
        SELECT DISTINCT doc_id AS teaching_doc_id
        FROM unnest(ARRAY[spec.document_id, unit.document_id, revision.document_id]) AS doc_id
        WHERE doc_id IS NOT NULL
      ) linked ON true
      LEFT JOIN library_documents td
        ON td.id=linked.teaching_doc_id AND td.workspace_id=${workspaceId}
      WHERE c.workspace_id=${workspaceId} AND c.id=ANY(${[...cardCandidateIds]}::uuid[])`;
    for (const row of cardRows) {
      addUuid(documentIds, row.source_document_id);
      addUuid(documentIds, row.teaching_doc_id);
      addUuid(documentIds, row.document_id);
      addUuid(retainedTeachingDocIds, row.teaching_doc_id);
      if (row.has_opening_lineage === true && !sameWorkspace) {
        throw new BackupRestoreError("VALIDATION", "Linked cards require their original workspace and source materials");
      }
      if (row.origin_valid === false) {
        throw new BackupRestoreError("VALIDATION", "Automatic card observation origin is unavailable");
      }
      if (row.teaching_revision_id != null && row.revision_exists === false) {
        const incomingDocId = incomingRevisionDocById.get(String(row.teaching_revision_id).toLowerCase());
        if (!incomingDocId) {
          throw new BackupRestoreError("VALIDATION", "Automatic card teaching document is unavailable");
        }
        addUuid(documentIds, incomingDocId);
        addUuid(retainedTeachingDocIds, incomingDocId);
      }
      if (
        row.card_readable === false
        || row.origin_admitted === false
        || row.source_doc_teaching_admitted === false
        || row.teaching_doc_active === false
        || row.teaching_doc_spec_allowed === false
      ) {
        throw new BackupRestoreError("VALIDATION", "Card source or teaching document is deleted, excluded, or unavailable");
      }
    }
    if (retainedTeachingDocIds.size > 0) {
      const teachingIds = [...retainedTeachingDocIds];
      const [teachingDocs, teachingBlocks, teachingRevisions, sourceVersions] = await Promise.all([
        sql`SELECT id, workspace_id, deleted_at FROM library_documents WHERE workspace_id=${workspaceId} AND id=ANY(${teachingIds}::uuid[])`,
        sql`SELECT id, document_id, type, content FROM library_blocks WHERE workspace_id=${workspaceId} AND document_id=ANY(${teachingIds}::uuid[])`,
        sql`SELECT id, document_id, reason, blocks FROM library_revisions WHERE workspace_id=${workspaceId} AND document_id=ANY(${teachingIds}::uuid[])`,
        readBackupLibrarySourceVersions(sql, workspaceId),
      ]);
      const existingTeachingDocs = new Map(teachingDocs.map(doc => [String(doc.id).toLowerCase(), doc]));
      for (const id of teachingIds) {
        const existingDoc = existingTeachingDocs.get(id);
        if (existingDoc ? existingDoc.deleted_at != null : !incomingActiveDocIds.has(id)) {
          throw new BackupRestoreError("VALIDATION", "Automatic card teaching document is unavailable");
        }
      }
      const privateLibrary = backupPrivateLibrary(
        teachingDocs as Record<string, unknown>[],
        teachingBlocks as Record<string, unknown>[],
        teachingRevisions as Record<string, unknown>[],
        "document_id",
        [],
        [],
        new Set([...sourceVersions.keys()].map(id => id.toLowerCase())),
      );
      if (teachingIds.some(id => !privateLibrary.documentAllowed(id))) {
        throw new BackupRestoreError("VALIDATION", "Automatic card teaching document is unavailable");
      }
    }
  }
  const validDocIds = [...documentIds];
  const validCardIds = [...cardCandidateIds];
  const current = validDocIds.length || validCardIds.length ? await sql`SELECT
      p.document_id,
      p.workspace_id,
      p.context_source_refs,
      ${validCardIds.length > 0 ? sql`(p.context_source_refs IS NOT NULL
        AND COALESCE(jsonb_path_exists(p.context_source_refs, '$.**.publicationCardIds'), false)
        AND EXISTS (
          SELECT 1 FROM ${notePublicationCardIds(sql, () => sql`p.context_source_refs`)} AS pub(card_id)
          WHERE pub.card_id=ANY(${validCardIds}::text[])
        ))` : sql`FALSE`} AS matched_by_publication_card,
      EXISTS (SELECT 1 FROM library_documents d_any WHERE d_any.id=p.document_id) AS doc_exists_anywhere,
      (d.id IS NOT NULL AND d.deleted_at IS NULL) AS doc_active
    FROM opening_note_provenance p
    LEFT JOIN library_documents d ON d.id=p.document_id AND d.workspace_id=${workspaceId}
    WHERE (
      ${validDocIds.length > 0 ? sql`p.document_id=ANY(${validDocIds}::uuid[])` : sql`FALSE`}
      ${validCardIds.length > 0 ? sql`OR (p.context_source_refs IS NOT NULL
        AND COALESCE(jsonb_path_exists(p.context_source_refs, '$.**.publicationCardIds'), false)
        AND EXISTS (
          SELECT 1 FROM ${notePublicationCardIds(sql, () => sql`p.context_source_refs`)} AS pub(card_id)
          WHERE pub.card_id=ANY(${validCardIds}::text[])
        ))` : sql``}
    )` : [];
  const existingById = new Map(current.map(row => [String(row.document_id).toLowerCase(), row]));
  type LineageCheck = {
    documentId: string;
    rawJson: unknown;
    memoryIds: string[];
    originTurnIds: string[];
    backingSourceIds: string[];
    requiresOriginalWorkspace: boolean;
    publicationDocUnavailable?: boolean;
  };
  const checks: LineageCheck[] = [];
  for (const row of current) {
    if (row.workspace_id !== undefined && String(row.workspace_id).toLowerCase() !== normalizedWorkspaceId) {
      throw new BackupRestoreError("VALIDATION", "Linked note provenance is unknown");
    }
    const documentId = String(row.document_id).toLowerCase();
    const parsed = parseNoteContextProvenanceRefs(row.context_source_refs);
    const backupRefs = parseBackupSourceRefs(row.context_source_refs);
    if (parsed === null || backupRefs === null) {
      throw new BackupRestoreError("VALIDATION", "Linked note provenance is unknown");
    }
    const matchedByPublicationCard = row.matched_by_publication_card === true;
    const publicationDocUnavailable = matchedByPublicationCard && row.doc_active === false
      && (row.doc_exists_anywhere === true || !incomingActiveDocIds.has(documentId));
    const memoryIds = parsed.find(ref => "memoryDependencyIds" in ref)?.memoryDependencyIds ?? [];
    const originTurnIds = noteOriginTurnIds(row.context_source_refs);
    checks.push({
      documentId,
      rawJson: row.context_source_refs,
      memoryIds,
      originTurnIds,
      backingSourceIds: memoryOnlyRefSourceIds(parsed),
      requiresOriginalWorkspace: backupRefs.length > 0 || memoryIds.length > 0 || originTurnIds.length > 0 || matchedByPublicationCard,
      publicationDocUnavailable,
    });
  }
  for (const record of asRecords(packed.records.documents)) {
    const value = readNoteBackupProvenance(record, modern);
    const documentId = record.id.toLowerCase();
    const existing = existingById.get(documentId);
    if (existing && !value) throw new BackupRestoreError("VALIDATION", "Restore cannot remove existing note provenance");
    if (value) {
      const memoryIds = value.memoryDependencyIds ?? [];
      const originTurnIds = value.originTurnIds ?? [];
      const serialized = canonicalNoteProvenanceEntries(
        value.contextSourceRefs,
        value.answerKeyBlockIds ?? [],
        [],
        {
          memoryDependencyIds: value.memoryDependencyIds,
          originTurnIds: value.originTurnIds,
          snippetLineageVersion: value.snippetLineageVersion,
        },
      );
      const parsed = parseNoteContextProvenanceRefs(serialized);
      if (parsed === null) throw new BackupRestoreError("VALIDATION", "Linked note provenance is unknown");
      checks.push({
        documentId,
        rawJson: serialized,
        memoryIds,
        originTurnIds,
        backingSourceIds: memoryOnlyRefSourceIds(parsed),
        requiresOriginalWorkspace: value.contextSourceRefs.length > 0 || memoryIds.length > 0 || originTurnIds.length > 0,
      });
    }
  }
  let ownerScope: { workspaceId: string; ownerUserId: string } | null | undefined;
  const getOwnerScope = async () => {
    if (ownerScope !== undefined) return ownerScope;
    const [ws] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${workspaceId}`;
    ownerScope = typeof ws?.owner_user_id === "string" ? { workspaceId, ownerUserId: ws.owner_user_id } : null;
    return ownerScope;
  };
  for (const check of checks) {
    if (check.requiresOriginalWorkspace && !sameWorkspace) {
      throw new BackupRestoreError("VALIDATION", "Linked notes require their original workspace and source material; native backup does not restore Opening sources");
    }
    if (check.publicationDocUnavailable) {
      throw new BackupRestoreError("VALIDATION", "Linked note source is deleted, excluded, or unavailable; restore was not applied");
    }
    const admitted = await sql`SELECT ${noteContextSourceRefsIncluded(sql, workspaceId, () => sql`${sql.json(check.rawJson as never)}::jsonb`, true)} AS included`;
    if (!admitted[0]?.included) {
      throw new BackupRestoreError("VALIDATION", "Linked note source is deleted, excluded, or unavailable; restore was not applied");
    }
    if (check.originTurnIds.length > 0 || check.memoryIds.length > 0 || check.backingSourceIds.length > 0) {
      const scope = await getOwnerScope();
      if (!scope
        || !await openingSnippetOriginsAvailable(sql, scope, check.originTurnIds)
        || !await openingCredentialMemoriesAvailable(sql, scope, check.memoryIds, check.backingSourceIds)) {
        throw new BackupRestoreError("VALIDATION", "Linked note origin turn or memory is deleted, excluded, or unavailable; restore was not applied");
      }
    }
  }
}

function teachingDocumentIds(card: NativeBackupRecord): string[] {
  if (card.originTeachingDocumentIds === undefined) return [];
  if (card.originObservationRootId == null || !Array.isArray(card.originTeachingDocumentIds)
    || !card.originTeachingDocumentIds.every(id => uuidSchema.safeParse(id).success)) {
    throw new BackupRestoreError("VALIDATION", "Automatic card teaching document lineage is invalid");
  }
  return [...new Set(card.originTeachingDocumentIds.map(id => String(id).toLowerCase()))];
}

/** Native cards keep their original source namespace; importing text cannot drop known lineage. */
export async function assertNativeCardRestorePrivacy(sql: Sql, workspaceId: string, packed: NativeBackupPackage, existingIds: ExistingBackupIds): Promise<void> {
  const modern = Number.parseInt(packed.schemaManifest.latestMigrationId.slice(0, 4), 10) >= 64;
  const sameWorkspace = packed.sourceWorkspaceId.toLowerCase() === workspaceId.toLowerCase();
  const retained = new Set((existingIds.cards ?? []).map(id => id.toLowerCase()));
  for (const card of asRecords(packed.records.cards)) {
    const cardId = uuidSchema.safeParse(card.id).success ? card.id.toLowerCase() : card.id;
    const ids = card.sourceIds === undefined && !modern ? [] : card.sourceIds;
    if (!Array.isArray(ids) || (card.originObservationRootId == null && ids.length > 32)
      || !ids.every(id => uuidSchema.safeParse(id).success)) {
      throw new BackupRestoreError("VALIDATION", "card source lineage is missing or invalid");
    }
    if (card.originObservationRootId != null) {
      if (!uuidSchema.safeParse(card.originObservationRootId).success || !sameWorkspace)
        throw new BackupRestoreError("VALIDATION", "automatic cards require the original observation workspace");
      const originObservationRootId = String(card.originObservationRootId).toLowerCase();
      const ownerUserId = typeof card.ownerUserId === "string" && uuidSchema.safeParse(card.ownerUserId).success
        ? card.ownerUserId.toLowerCase() : String(card.ownerUserId);
      const [origin] = await sql`SELECT id FROM opening_learning_observations
        WHERE id=${originObservationRootId} AND workspace_id=${workspaceId}
          AND owner_user_id=${ownerUserId} AND COALESCE(root_observation_id,id)=id`;
      if (!origin) throw new BackupRestoreError("VALIDATION", "automatic card observation origin is unavailable");
    }
    const [current] = retained.has(card.id.toLowerCase()) ? await sql`SELECT source_ids,origin_observation_root_id,source_document_id
      FROM cards WHERE id=${cardId} AND workspace_id=${workspaceId} FOR UPDATE` : [];
    if (current && ((current.origin_observation_root_id != null && card.originObservationRootId != null
      && String(current.origin_observation_root_id).toLowerCase() !== String(card.originObservationRootId).toLowerCase())
      || (current.source_document_id != null && card.sourceDocumentId != null
        && String(current.source_document_id).toLowerCase() !== String(card.sourceDocumentId).toLowerCase()))) {
      throw new BackupRestoreError("VALIDATION", "Restore cannot replace retained card origins");
    }
    if (ids.length && !sameWorkspace) throw new BackupRestoreError("VALIDATION", "linked cards require their original workspace and source materials");
    const combined = [...new Set([...ids, ...((current?.source_ids ?? []) as string[])].map(id => id.toLowerCase()))];
    if (current && combined.length > 32) {
      throw new BackupRestoreError("VALIDATION", "Retained card source lineage exceeds 32 materials");
    }
    const [admitted] = await sql`SELECT ${cardSourcesIncluded(sql, workspaceId, sql`${combined}::uuid[]`)} AS included`;
    if (!admitted?.included) throw new BackupRestoreError("VALIDATION", "card source is deleted, excluded, or unavailable");
  }
}

/** Apply privacy metadata to admitted parents, including content left in place by skip. */
export async function retainNativeRestoreProvenance(tx: Sql, workspaceId: string, packed: NativeBackupPackage, existingIds: ExistingBackupIds) {
  for (const document of asRecords(packed.records.documents)) {
    const note = readNoteBackupProvenance(document, false);
    if (note) {
      const documentId = uuidSchema.safeParse(document.id).success ? document.id.toLowerCase() : document.id;
      await mergeNotePublicationProvenance(
        tx,
        workspaceId,
        documentId,
        note.contextSourceRefs,
        note.answerKeyBlockIds,
        [],
        {
          memoryDependencyIds: note.memoryDependencyIds,
          originTurnIds: note.originTurnIds,
          snippetLineageVersion: note.snippetLineageVersion,
        },
      );
    }
  }
  const retained = new Set((existingIds.cards ?? []).map(id => id.toLowerCase()));
  const cardsByDocument = new Map<string, string[]>();
  for (const card of asRecords(packed.records.cards)) {
    const cardId = uuidSchema.safeParse(card.id).success ? card.id.toLowerCase() : card.id;
    const origin = typeof card.originObservationRootId === "string" && uuidSchema.safeParse(card.originObservationRootId).success
      ? card.originObservationRootId.toLowerCase()
      : card.originObservationRootId as string | null | undefined;
    const noteId = typeof card.sourceDocumentId === "string" && uuidSchema.safeParse(card.sourceDocumentId).success
      ? card.sourceDocumentId.toLowerCase()
      : card.sourceDocumentId as string | null | undefined;
    const sourceIds = Array.isArray(card.sourceIds)
      ? card.sourceIds.map(id => typeof id === "string" && uuidSchema.safeParse(id).success ? id.toLowerCase() : String(id))
      : [];
    if (retained.has(card.id.toLowerCase()) && (sourceIds.length || origin || noteId)) {
      if (noteId) {
        const [document] = await tx`SELECT id FROM library_documents WHERE id=${noteId} AND workspace_id=${workspaceId} FOR SHARE`;
        if (!document) throw new BackupRestoreError("VALIDATION", "Card note is outside target workspace");
      }
      await tx`UPDATE cards c SET source_ids=ARRAY(
        SELECT DISTINCT source.id FROM unnest(c.source_ids || ${sourceIds}::uuid[]) AS source(id) ORDER BY source.id),
        origin_observation_root_id=COALESCE(c.origin_observation_root_id,${origin ?? null}),
        source_document_id=COALESCE(c.source_document_id,${noteId ?? null})
        WHERE c.id=${cardId} AND c.workspace_id=${workspaceId}`;
    }
    for (const id of teachingDocumentIds(card)) {
      const cards = cardsByDocument.get(id) ?? [];
      cards.push(cardId);
      cardsByDocument.set(id, cards);
    }
  }
  for (const [id, cards] of cardsByDocument) {
    const [document] = await tx`SELECT id FROM library_documents WHERE id=${id} AND workspace_id=${workspaceId} AND deleted_at IS NULL FOR SHARE`;
    if (!document) throw new BackupRestoreError("VALIDATION", "Automatic card teaching document is unavailable");
    await mergeNotePublicationProvenance(tx, workspaceId, id, [], [], cards);
  }
}
