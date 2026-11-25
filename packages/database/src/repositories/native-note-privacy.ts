import { cardReadable, cardSourcesIncluded } from "./card-sources";
import { uuidSchema } from "@aistudy/contracts";
import { notePublicationMetadata, type ExistingBackupIds } from "@aistudy/domain";
import type { Sql } from "postgres";
import type { NativeBackupPackage } from "@aistudy/contracts";
import { retainBackupEventChains, type NativeBackupSnapshot, type NativeBackupRecord } from "@aistudy/domain/native";
import {
  isMemoryDependencyMetadata,
  isVerifiedSnippetLineage,
  memoryOnlyRefSourceIds,
  noteContextSourceRefsIncluded,
  noteOriginTurnIds,
  openingCredentialMemoriesAvailable,
  openingSnippetOriginsAvailable,
  parseNoteContextProvenanceRefs,
} from "./opening-context-provenance";
import { BackupRestoreError } from "./backup-types";
import { asRecords, filesFromBlocks } from "./backup-map";
import { attachNativeCardPublicationSources } from "./native-backup-teaching";
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
  const isBlockedDoc = (id: unknown) => typeof id === "string" && normalizedProvenance.get(id.toLowerCase()) === null;
  const blockedDocs = new Set([...normalizedProvenance].filter(([, value]) => value === null).map(([id]) => id));
  const blockedBlocks = new Set(snapshot.blocks.filter(row => isBlockedDoc(row.documentId)).map(row => row.id));
  const blockedCards = new Set(snapshot.cards.filter(row => privateCards.has(row.id) || isBlockedDoc(row.sourceDocumentId)
    || Array.isArray(row.originTeachingDocumentIds) && row.originTeachingDocumentIds.some(id => isBlockedDoc(id))).map(row => row.id));
  const blocked = new Set([...blockedDocs, ...[...blockedBlocks].map(id => id.toLowerCase()), ...[...blockedCards].map(id => id.toLowerCase())]);
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
    cards: snapshot.cards.filter(row => !blockedCards.has(row.id)),
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
  const documentIds = new Set(asRecords(packed.records.documents).map(row => row.id));
  for (const row of [...asRecords(packed.records.blocks), ...asRecords(packed.records.revisions)]) {
    if (typeof row.documentId === "string" && uuidSchema.safeParse(row.documentId).success) documentIds.add(row.documentId);
  }
  for (const card of asRecords(packed.records.cards)) {
    if (typeof card.sourceDocumentId === "string" && uuidSchema.safeParse(card.sourceDocumentId).success) documentIds.add(card.sourceDocumentId);
    for (const id of teachingDocumentIds(card)) documentIds.add(id);
  }
  const validDocIds = [...documentIds].filter(id => uuidSchema.safeParse(id).success);
  const current = validDocIds.length ? await sql`SELECT document_id, context_source_refs FROM opening_note_provenance
    WHERE workspace_id=${workspaceId} AND document_id=ANY(${validDocIds}::uuid[])` : [];
  const existingById = new Map(current.map(row => [String(row.document_id).toLowerCase(), row]));
  type LineageCheck = {
    rawJson: unknown;
    memoryIds: string[];
    originTurnIds: string[];
    backingSourceIds: string[];
  };
  const checks: LineageCheck[] = [];
  for (const row of current) {
    const parsed = parseNoteContextProvenanceRefs(row.context_source_refs);
    const backupRefs = parseBackupSourceRefs(row.context_source_refs);
    if (parsed === null || backupRefs === null) {
      throw new BackupRestoreError("VALIDATION", "Linked note provenance is unknown");
    }
    checks.push({
      rawJson: row.context_source_refs,
      memoryIds: parsed.find(ref => "memoryDependencyIds" in ref)?.memoryDependencyIds ?? [],
      originTurnIds: noteOriginTurnIds(row.context_source_refs),
      backingSourceIds: memoryOnlyRefSourceIds(parsed),
    });
  }
  for (const record of asRecords(packed.records.documents)) {
    const value = readNoteBackupProvenance(record, modern);
    const existing = existingById.get(record.id.toLowerCase());
    if (existing && !value) throw new BackupRestoreError("VALIDATION", "Restore cannot remove existing note provenance");
    if (value) {
      if ((value.contextSourceRefs.length > 0
        || (value.memoryDependencyIds?.length ?? 0) > 0
        || (value.originTurnIds?.length ?? 0) > 0)
        && packed.sourceWorkspaceId !== workspaceId) {
        throw new BackupRestoreError("VALIDATION", "Linked notes require their original workspace and source material; native backup does not restore Opening sources");
      }
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
        rawJson: serialized,
        memoryIds: value.memoryDependencyIds ?? [],
        originTurnIds: value.originTurnIds ?? [],
        backingSourceIds: memoryOnlyRefSourceIds(parsed),
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
  const retained = new Set(existingIds.cards);
  for (const card of asRecords(packed.records.cards)) {
    const ids = card.sourceIds === undefined && !modern ? [] : card.sourceIds;
    if (!Array.isArray(ids) || (card.originObservationRootId == null && ids.length > 32)
      || !ids.every(id => uuidSchema.safeParse(id).success)) {
      throw new BackupRestoreError("VALIDATION", "card source lineage is missing or invalid");
    }
    if (card.originObservationRootId != null) {
      if (!uuidSchema.safeParse(card.originObservationRootId).success || packed.sourceWorkspaceId !== workspaceId)
        throw new BackupRestoreError("VALIDATION", "automatic cards require the original observation workspace");
      const [origin] = await sql`SELECT id FROM opening_learning_observations
        WHERE id=${String(card.originObservationRootId)} AND workspace_id=${workspaceId}
          AND owner_user_id=${String(card.ownerUserId)} AND COALESCE(root_observation_id,id)=id`;
      if (!origin) throw new BackupRestoreError("VALIDATION", "automatic card observation origin is unavailable");
    }
    const [current] = retained.has(card.id) ? await sql`SELECT source_ids,origin_observation_root_id,source_document_id
      FROM cards WHERE id=${card.id} AND workspace_id=${workspaceId} FOR UPDATE` : [];
    if (current && ((current.origin_observation_root_id != null && card.originObservationRootId != null
      && current.origin_observation_root_id !== card.originObservationRootId)
      || (current.source_document_id != null && card.sourceDocumentId != null && current.source_document_id !== card.sourceDocumentId))) {
      throw new BackupRestoreError("VALIDATION", "Restore cannot replace retained card origins");
    }
    if (ids.length && packed.sourceWorkspaceId !== workspaceId) throw new BackupRestoreError("VALIDATION", "linked cards require their original workspace and source materials");
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
      await mergeNotePublicationProvenance(
        tx,
        workspaceId,
        document.id,
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
  const retained = new Set(existingIds.cards);
  const cardsByDocument = new Map<string, string[]>();
  for (const card of asRecords(packed.records.cards)) {
    const origin = card.originObservationRootId as string | null | undefined;
    const noteId = card.sourceDocumentId as string | null | undefined;
    if (retained.has(card.id) && (Array.isArray(card.sourceIds) && card.sourceIds.length || origin || noteId)) {
      if (noteId) {
        const [document] = await tx`SELECT id FROM library_documents WHERE id=${noteId} AND workspace_id=${workspaceId} FOR SHARE`;
        if (!document) throw new BackupRestoreError("VALIDATION", "Card note is outside target workspace");
      }
      await tx`UPDATE cards c SET source_ids=ARRAY(
        SELECT DISTINCT source.id FROM unnest(c.source_ids || ${(card.sourceIds ?? []) as string[]}::uuid[]) AS source(id) ORDER BY source.id),
        origin_observation_root_id=COALESCE(c.origin_observation_root_id,${origin ?? null}),
        source_document_id=COALESCE(c.source_document_id,${noteId ?? null})
        WHERE c.id=${card.id} AND c.workspace_id=${workspaceId}`;
    }
    for (const id of teachingDocumentIds(card)) {
      const cards = cardsByDocument.get(id) ?? [];
      cards.push(card.id);
      cardsByDocument.set(id, cards);
    }
  }
  for (const [id, cards] of cardsByDocument) {
    const [document] = await tx`SELECT id FROM library_documents WHERE id=${id} AND workspace_id=${workspaceId} AND deleted_at IS NULL FOR SHARE`;
    if (!document) throw new BackupRestoreError("VALIDATION", "Automatic card teaching document is unavailable");
    await mergeNotePublicationProvenance(tx, workspaceId, id, [], [], cards);
  }
}
