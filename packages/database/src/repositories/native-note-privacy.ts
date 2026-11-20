import { cardReadable, cardSourcesIncluded } from "./card-sources";
import { uuidSchema } from "@aistudy/contracts";
import type { Sql } from "postgres";
import type { NativeBackupPackage } from "@aistudy/contracts";
import { retainBackupEventChains, type NativeBackupSnapshot, type NativeBackupRecord } from "@aistudy/domain/native";
import { contextSourceRefsIncluded, parseContextSourceRefs } from "./opening-context-provenance";
import { BackupRestoreError } from "./backup-types";
import { asRecords, filesFromBlocks } from "./backup-map";
import { attachNativeCardPublicationSources, parseBackupSourceRefs, type BackupSourceRef } from "./native-backup-teaching";

export type NoteBackupProvenance = { contextSourceRefs: BackupSourceRef[] };

/** Remove the whole linked note, including historical text and native dependants. */
export function filterNativeNotes(snapshot: NativeBackupSnapshot, provenance: ReadonlyMap<string, NoteBackupProvenance | null>,
  privateCards: ReadonlySet<string> = new Set()): NativeBackupSnapshot {
  const blockedDocs = new Set([...provenance].filter(([, value]) => value === null).map(([id]) => id));
  const blockedBlocks = new Set(snapshot.blocks.filter(row => blockedDocs.has(String(row.documentId))).map(row => row.id));
  const blockedCards = new Set(snapshot.cards.filter(row => privateCards.has(row.id) || blockedDocs.has(String(row.sourceDocumentId))
    || Array.isArray(row.originTeachingDocumentIds) && row.originTeachingDocumentIds.some(id => blockedDocs.has(id))).map(row => row.id));
  const blocked = new Set([...blockedDocs, ...blockedBlocks, ...blockedCards]);
  const blocks = snapshot.blocks.filter(row => !blockedDocs.has(String(row.documentId)));
  return {
    ...snapshot,
    documents: snapshot.documents.filter(row => !blockedDocs.has(row.id)).map(row => ({ ...row, openingProvenance: provenance.get(row.id) ?? null })),
    blocks,
    revisions: snapshot.revisions.filter(row => !blockedDocs.has(String(row.documentId))),
    relations: snapshot.relations.filter(row => !blocked.has(String(row.fromId)) && !blocked.has(String(row.toId))),
    memberships: snapshot.memberships.filter(row => row.assetType !== "source" && !blocked.has(String(row.assetId))),
    cards: snapshot.cards.filter(row => !blockedCards.has(row.id)),
    events: retainBackupEventChains(snapshot.events.filter(row => !blocked.has(String(row.contentId))), "correctsEventId"),
    promotions: snapshot.promotions.filter(row => !blocked.has(String(row.targetId))).map(row => Array.isArray(row.targets)
      ? { ...row, targets: row.targets.filter(target => !blocked.has(String(target?.targetId))) } : row),
    files: filesFromBlocks(blocks),
  };
}

export async function applyNativeNoteExportPrivacy(sql: Sql, workspaceId: string, snapshot: NativeBackupSnapshot,
  publications: ReadonlyMap<string, BackupSourceRef[]>): Promise<NativeBackupSnapshot> {
  const rows = await sql`SELECT document_id, context_source_refs,
    ${contextSourceRefsIncluded(sql, workspaceId, sql`context_source_refs`, true)} AS included
    FROM opening_note_provenance WHERE workspace_id=${workspaceId}`;
  const provenance = new Map<string, NoteBackupProvenance | null>();
  for (const [id, refs] of publications) {
    if (refs.length) provenance.set(id, { contextSourceRefs: refs });
  }
  for (const row of rows) {
    const id = String(row.document_id);
    const refs = Array.isArray(row.context_source_refs)
      ? parseBackupSourceRefs([...row.context_source_refs, ...(publications.get(id) ?? [])]) : null;
    provenance.set(id, row.included && refs !== null ? { contextSourceRefs: refs } : null);
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
  const refs = parseBackupSourceRefs((value as Record<string, unknown>).contextSourceRefs);
  if (refs === null) throw new BackupRestoreError("VALIDATION", "Backup note provenance is unknown");
  return { contextSourceRefs: refs };
}

export async function assertNativeNoteRestorePrivacy(sql: Sql, workspaceId: string, packed: NativeBackupPackage): Promise<void> {
  const modern = Number.parseInt(packed.schemaManifest.latestMigrationId.slice(0, 4), 10) >= 35;
  const documentIds = new Set(asRecords(packed.records.documents).map(row => row.id));
  for (const row of [...asRecords(packed.records.blocks), ...asRecords(packed.records.revisions)]) {
    if (typeof row.documentId === "string") documentIds.add(row.documentId);
  }
  for (const card of asRecords(packed.records.cards)) {
    if (typeof card.sourceDocumentId === "string") documentIds.add(card.sourceDocumentId);
  }
  const current = documentIds.size ? await sql`SELECT document_id, context_source_refs FROM opening_note_provenance
    WHERE workspace_id=${workspaceId} AND document_id=ANY(${[...documentIds]}::uuid[])` : [];
  const origins = current.map(row => ({ contextSourceRefs: parseContextSourceRefs(row.context_source_refs) }));
  for (const record of asRecords(packed.records.documents)) {
    const value = readNoteBackupProvenance(record, modern);
    if (value) {
      if (value.contextSourceRefs.length && packed.sourceWorkspaceId !== workspaceId) throw new BackupRestoreError("VALIDATION", "Linked notes require their original workspace and source material; native backup does not restore Opening sources");
      origins.push(value);
    }
    const existing = current.find(row => row.document_id === record.id);
    if (existing && !value) throw new BackupRestoreError("VALIDATION", "Restore cannot remove existing note provenance");
  }
  for (const origin of origins) {
    if (origin.contextSourceRefs === null) throw new BackupRestoreError("VALIDATION", "Linked note provenance is unknown");
    const admitted = await sql`SELECT ${contextSourceRefsIncluded(sql, workspaceId, sql`${sql.json(origin.contextSourceRefs)}::jsonb`, true)} AS included`;
    if (!admitted[0]!.included) throw new BackupRestoreError("VALIDATION", "Linked note source is deleted, excluded, or unavailable; restore was not applied");
  }
}

/** Native cards keep their original source namespace; importing text cannot drop known lineage. */
export async function assertNativeCardRestorePrivacy(sql: Sql, workspaceId: string, packed: NativeBackupPackage): Promise<void> {
  const modern = Number.parseInt(packed.schemaManifest.latestMigrationId.slice(0, 4), 10) >= 64;
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
    const [current] = await sql`SELECT source_ids FROM cards WHERE id=${card.id} AND workspace_id=${workspaceId}`;
    if (current && (current.source_ids as string[]).some(id => !ids.includes(id))) throw new BackupRestoreError("VALIDATION", "restore cannot remove card source lineage");
    if (ids.length && packed.sourceWorkspaceId !== workspaceId) throw new BackupRestoreError("VALIDATION", "linked cards require their original workspace and source materials");
    const [admitted] = await sql`SELECT ${cardSourcesIncluded(sql, workspaceId, sql`${ids}::uuid[]`)} AS included`;
    if (!admitted?.included) throw new BackupRestoreError("VALIDATION", "card source is deleted, excluded, or unavailable");
  }
}
