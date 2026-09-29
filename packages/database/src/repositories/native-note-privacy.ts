import type { Sql } from "postgres";
import type { NativeBackupPackage } from "@aistudy/contracts";
import type { NativeBackupSnapshot, NativeBackupRecord } from "@aistudy/domain/native";
import { contextSourceRefsIncluded, parseContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";
import { BackupRestoreError } from "./backup-types";
import { asRecords, filesFromBlocks } from "./backup-map";

export type NoteBackupProvenance = { contextSourceRefs: ContextSourceRef[] };

/** Remove the whole linked note, including historical text and native dependants. */
export function filterNativeNotes(snapshot: NativeBackupSnapshot, provenance: ReadonlyMap<string, NoteBackupProvenance | null>): NativeBackupSnapshot {
  const blockedDocs = new Set([...provenance].filter(([, value]) => value === null).map(([id]) => id));
  const blockedBlocks = new Set(snapshot.blocks.filter(row => blockedDocs.has(String(row.documentId))).map(row => row.id));
  const blockedCards = new Set(snapshot.cards.filter(row => blockedDocs.has(String(row.sourceDocumentId))).map(row => row.id));
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
    events: snapshot.events.filter(row => !blocked.has(String(row.contentId))),
    promotions: snapshot.promotions.filter(row => !blocked.has(String(row.targetId))),
    files: filesFromBlocks(blocks),
  };
}

export async function applyNativeNoteExportPrivacy(sql: Sql, workspaceId: string, snapshot: NativeBackupSnapshot): Promise<NativeBackupSnapshot> {
  const rows = await sql`SELECT document_id, context_source_refs,
    ${contextSourceRefsIncluded(sql, workspaceId, sql`context_source_refs`, true)} AS included
    FROM opening_note_provenance WHERE workspace_id=${workspaceId}`;
  const provenance = new Map<string, NoteBackupProvenance | null>();
  for (const row of rows) {
    const refs = parseContextSourceRefs(row.context_source_refs);
    provenance.set(String(row.document_id), row.included && refs !== null ? { contextSourceRefs: refs } : null);
  }
  return filterNativeNotes(snapshot, provenance);
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
  const refs = parseContextSourceRefs((value as Record<string, unknown>).contextSourceRefs);
  if (refs === null) throw new BackupRestoreError("VALIDATION", "Backup note provenance is unknown");
  return { contextSourceRefs: refs };
}

export async function assertNativeNoteRestorePrivacy(sql: Sql, workspaceId: string, packed: NativeBackupPackage): Promise<void> {
  const modern = Number.parseInt(packed.schemaManifest.latestMigrationId.slice(0, 4), 10) >= 35;
  const documentIds = new Set(asRecords(packed.records.documents).map(row => row.id));
  for (const row of [...asRecords(packed.records.blocks), ...asRecords(packed.records.revisions)]) {
    if (typeof row.documentId === "string") documentIds.add(row.documentId);
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
