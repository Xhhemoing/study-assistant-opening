import { notePublicationMetadata } from "@aistudy/domain";
import type { Sql, TransactionSql } from "postgres";
import { asObject } from "./backup-map";
import { isBackupAnswerBlock } from "./backup-private-library";
import {
  hasValidNoteMetadataStructure,
  isMemoryDependencyMetadata,
  isVerifiedSnippetLineage,
  noteOriginTurnIds,
  parseContextSourceRefs,
  parseNoteContextProvenanceRefs,
  type ContextSourceRef,
} from "./opening-context-provenance";

type Db = Sql | TransactionSql;
type Row = Record<string, unknown>;
type PublicationSourceRef = ContextSourceRef & { publication: true };
export type BackupSourceRef = ContextSourceRef & { publication?: true };
export type NoteProvenanceLineageInput = {
  memoryDependencyIds?: string[];
  originTurnIds?: string[];
  snippetLineageVersion?: 1;
};

export function answerKeyBlockIds(order: unknown): string[] {
  if (!Array.isArray(order)) return [];
  return order.flatMap(ref => {
    const block = asObject(ref);
    return block && isBackupAnswerBlock(block) && typeof block.blockId === "string" ? [block.blockId.toLowerCase()] : [];
  });
}

export function parseBackupSourceRefs(value: unknown): BackupSourceRef[] | null {
  if (!hasValidNoteMetadataStructure(value)) return null;
  const sources = value.filter(ref => !notePublicationMetadata(ref));
  for (const ref of sources) {
    if (isMemoryDependencyMetadata(ref)) continue;
    const obj = asObject(ref);
    if (!obj || (obj.publication !== undefined && obj.publication !== true)) return null;
  }
  const refs = parseContextSourceRefs(sources);
  if (!refs) return null;
  const publications = new Set(parseContextSourceRefs(sources.filter(ref => asObject(ref)?.publication === true))
    ?.map(ref => `${ref.sourceId}:${ref.sourceVersion}`));
  return refs.map(ref => publications.has(`${ref.sourceId}:${ref.sourceVersion}`) ? { ...ref, publication: true } : ref);
}

/** Activity-only sources use the current version when there is no explicit citation. */
export function publicationSourceCandidates(spec: Row): unknown[] {
  const citations = Array.isArray(spec.source_refs) ? spec.source_refs : [];
  const activityIds = Array.isArray(spec.activity_source_ids) ? spec.activity_source_ids : [];
  const citedIds = new Set(citations.map(value => String(asObject(value)?.sourceId).toLowerCase()));
  return [...citations, ...activityIds.filter(id => !citedIds.has(String(id).toLowerCase())).map(sourceId => ({ sourceId }))];
}

export function publicationSourceRefsByDocument(specs: Row[], sourceVersions: ReadonlyMap<string, number>) {
  const documents = new Map<string, PublicationSourceRef[]>();
  for (const spec of specs) {
    if (typeof spec.document_id !== "string" || !Array.isArray(spec.source_refs)) continue;
    const id = spec.document_id.toLowerCase();
    const refs = documents.get(id) ?? [];
    for (const value of publicationSourceCandidates(spec)) {
      const citation = asObject(value);
      if (typeof citation?.sourceId !== "string") continue;
      const sourceId = citation.sourceId.toLowerCase();
      const rawVersion = citation.version ?? citation.sourceVersion;
      const version = typeof rawVersion === "string" && /^\d+$/.test(rawVersion) ? Number(rawVersion) : rawVersion;
      const currentVersion = sourceVersions.get(sourceId);
      const sourceVersion = typeof version === "number" && Number.isSafeInteger(version) && version >= 0
        ? version : currentVersion ?? 0;
      refs.push({ sourceId, sourceVersion, publication: true });
    }
    documents.set(id, refs);
  }
  return documents;
}

export function publicationMetadataIds(value: unknown, key: "answerKeyBlockIds" | "publicationCardIds"): string[] {
  return Array.isArray(value) ? [...new Set(value.flatMap(ref => notePublicationMetadata(ref)?.[key] ?? []))] : [];
}

export function publicationAnswerKeysByDocument(specs: Row[], provenance: Row[]) {
  const keys = new Map<string, string[]>();
  const add = (id: unknown, ids: string[]) => {
    const doc = String(id).toLowerCase();
    if (ids.length) keys.set(doc, [...new Set([...(keys.get(doc) ?? []), ...ids])]);
  };
  for (const spec of specs) add(spec.document_id, answerKeyBlockIds(spec.block_order));
  for (const row of provenance) add(row.document_id, publicationMetadataIds(row.context_source_refs, "answerKeyBlockIds"));
  return keys;
}

export function publicationMetadata(answerIds: string[], cardIds: string[] = []) {
  return [
    ...(answerIds.length ? [{ answerKeyBlockIds: [...new Set(answerIds)] }] : []),
    ...(cardIds.length ? [{ publicationCardIds: [...new Set(cardIds)] }] : []),
  ];
}

export function historicalTeachingDocumentsByCard(rows: Row[]) {
  const documentsByCard = new Map<string, string[]>();
  for (const row of rows) for (const cardId of publicationMetadataIds(row.context_source_refs, "publicationCardIds")) {
    const documents = documentsByCard.get(cardId) ?? [];
    documents.push(String(row.document_id).toLowerCase());
    documentsByCard.set(cardId, documents);
  }
  return documentsByCard;
}

export function canonicalNoteProvenanceEntries(
  refs: BackupSourceRef[],
  answerIds: string[] = [],
  cardIds: string[] = [],
  lineage?: NoteProvenanceLineageInput,
): unknown[] {
  const canonicalRefs = parseBackupSourceRefs(refs) ?? [];
  const memoryIds = [...new Set((lineage?.memoryDependencyIds ?? []).map(id => id.toLowerCase()))].sort();
  const originTurnIds = [...new Set((lineage?.originTurnIds ?? []).map(id => id.toLowerCase()))].sort();
  const normalizedAnswers = [...new Set(answerIds.map(id => id.toLowerCase()))];
  const normalizedCards = [...new Set(cardIds.map(id => id.toLowerCase()))];
  return [
    ...canonicalRefs,
    ...(memoryIds.length > 0 ? [{ memoryDependencyIds: memoryIds }] : []),
    ...(lineage?.snippetLineageVersion === 1 ? [{ snippetLineageVersion: 1 as const }] : []),
    ...(originTurnIds.length > 0 ? [{ originTurnIds }] : []),
    ...publicationMetadata(normalizedAnswers, normalizedCards),
  ];
}

export async function mergeNotePublicationProvenance(
  tx: Db,
  workspaceId: string,
  documentId: string,
  refs: BackupSourceRef[],
  answerIds: string[] = [],
  cardIds: string[] = [],
  lineage?: NoteProvenanceLineageInput,
) {
  const incoming = canonicalNoteProvenanceEntries(refs, answerIds, cardIds, lineage);
  const [existing] = await tx`SELECT workspace_id, context_source_refs FROM opening_note_provenance
    WHERE document_id=${documentId} FOR UPDATE`;
  if (existing) {
    if (String(existing.workspace_id).toLowerCase() !== workspaceId.toLowerCase()) return;
    const raw = existing.context_source_refs;
    const existingProvenance = parseNoteContextProvenanceRefs(raw);
    const existingRefs = parseBackupSourceRefs(raw);
    if (existingProvenance !== null && existingRefs !== null) {
      const existingMemoryIds = existingProvenance.find(ref => "memoryDependencyIds" in ref)?.memoryDependencyIds ?? [];
      const existingOriginTurnIds = noteOriginTurnIds(raw);
      const existingSnippetVersion = Array.isArray(raw) && raw.some(isVerifiedSnippetLineage) ? 1 as const : undefined;
      const existingAnswers = publicationMetadataIds(raw, "answerKeyBlockIds");
      const existingCards = publicationMetadataIds(raw, "publicationCardIds");
      const merged = canonicalNoteProvenanceEntries(
        [...existingRefs, ...refs],
        [...existingAnswers, ...answerIds],
        [...existingCards, ...cardIds],
        {
          memoryDependencyIds: [...existingMemoryIds, ...(lineage?.memoryDependencyIds ?? [])],
          originTurnIds: [...existingOriginTurnIds, ...(lineage?.originTurnIds ?? [])],
          snippetLineageVersion: lineage?.snippetLineageVersion === 1 || existingSnippetVersion === 1 ? 1 : undefined,
        },
      );
      await tx`UPDATE opening_note_provenance SET context_source_refs=${tx.json(merged as never)}
        WHERE document_id=${documentId} AND workspace_id=${workspaceId}`;
      return;
    }
  }
  // A null entry keeps unknown source lineage inadmissible while retaining redaction metadata.
  await tx`INSERT INTO opening_note_provenance AS p(document_id,workspace_id,context_source_refs)
    VALUES(${documentId},${workspaceId},${tx.json(incoming as never)})
    ON CONFLICT(document_id) DO UPDATE SET context_source_refs = (
      SELECT COALESCE(jsonb_agg(DISTINCT ref), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(p.context_source_refs, '[null]'::jsonb) || EXCLUDED.context_source_refs) ref
    )
    WHERE p.workspace_id=EXCLUDED.workspace_id`;
}
