import type { Sql, TransactionSql } from "postgres";
import { CardRepositoryError } from "./cards-types";
import { contextSourceRefsIncluded, parseContextSourceRefs } from "./opening-context-provenance";

type Db = Sql | TransactionSql;
/** Identity-based lineage remains private after source exclusion/deletion, including historical text. */
export function cardSourcesIncluded(db: Db, workspaceId: string, ids: ReturnType<Db>) {
  return db`NOT EXISTS (SELECT 1 FROM unnest(${ids}::uuid[]) card_source(id)
    WHERE NOT EXISTS (SELECT 1 FROM opening_sources s WHERE s.id=card_source.id
      AND s.workspace_id=${workspaceId} AND s.upload_state='uploaded'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${workspaceId} AND e.source_id=s.id)))`;
}
export function cardReadable(db: Db, workspaceId: string) {
  const document = db`c.source_document_id`;
  return db`${cardSourcesIncluded(db, workspaceId, db`c.source_ids`)}
    AND (${document} IS NULL OR EXISTS (SELECT 1 FROM library_documents d WHERE d.id=${document} AND d.workspace_id=${workspaceId}))
    AND NOT EXISTS (SELECT 1 FROM opening_note_provenance np WHERE np.document_id=${document}
      AND (np.workspace_id<>${workspaceId} OR NOT (${contextSourceRefsIncluded(db, workspaceId, db`np.context_source_refs`, true)})))`;
}

/** Legacy note-linked cards inherit all note lineage when their review becomes a learning fact. */
export async function readCardSourceIds(db: Db, workspaceId: string, cardId: string): Promise<string[]> {
  const [row] = await db`SELECT c.source_ids,np.document_id AS provenance_id,np.context_source_refs FROM cards c
    LEFT JOIN opening_note_provenance np ON np.document_id=c.source_document_id AND np.workspace_id=c.workspace_id
    WHERE c.id=${cardId} AND c.workspace_id=${workspaceId}`;
  if (!row) throw new CardRepositoryError("NOT_FOUND", "card not found");
  const refs = row.provenance_id ? parseContextSourceRefs(row.context_source_refs) : [];
  if (!refs) throw new CardRepositoryError("NOT_FOUND", "card source provenance unavailable");
  const ids = [...new Set([...(row.source_ids as string[]), ...refs.map(ref => ref.sourceId)])].sort();
  if (ids.length > 32) throw new CardRepositoryError("VALIDATION", "卡片来源超过32份材料，无法完整写入学习记录。");
  return ids;
}
