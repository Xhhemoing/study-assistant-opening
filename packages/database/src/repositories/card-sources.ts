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

export type CardEvidenceSkipReason = "skipped_no_course" | "skipped_course_archived" | "skipped_source_unavailable";
export type CardEvidencePlan =
  | { kind: "record"; courseId: string; sourceIds: string[] }
  | { kind: "skip"; reason: CardEvidenceSkipReason };

/**
 * Whether this card's review can become a learning fact. Legacy note-linked cards
 * inherit all note lineage. An archived course or a source that cannot be admitted
 * (deleted, excluded, re-parsing, >32 sources) skips the fact but never the SRS review.
 * Mirrors the admission rules of createOpeningLearningSessionInTx/admitLearningSources.
 */
export async function planCardEvidence(db: Db, workspaceId: string, card: { id: string; courseId: string | null }): Promise<CardEvidencePlan> {
  if (!card.courseId) return { kind: "skip", reason: "skipped_no_course" };
  const [course] = await db`SELECT id FROM courses WHERE id=${card.courseId} AND workspace_id=${workspaceId} AND archived_at IS NULL`;
  if (!course) return { kind: "skip", reason: "skipped_course_archived" };
  const [row] = await db`SELECT c.source_ids,np.document_id AS provenance_id,np.context_source_refs FROM cards c
    LEFT JOIN opening_note_provenance np ON np.document_id=c.source_document_id AND np.workspace_id=c.workspace_id
    WHERE c.id=${card.id} AND c.workspace_id=${workspaceId}`;
  if (!row) throw new CardRepositoryError("NOT_FOUND", "card not found");
  const refs = row.provenance_id ? parseContextSourceRefs(row.context_source_refs) : [];
  if (!refs) return { kind: "skip", reason: "skipped_source_unavailable" };
  const ids = [...new Set([...(row.source_ids as string[]), ...refs.map(ref => ref.sourceId)])].sort();
  if (ids.length > 32) return { kind: "skip", reason: "skipped_source_unavailable" };
  if (ids.length) {
    const [admitted] = await db`SELECT count(*)::int AS n FROM opening_sources s
      WHERE s.workspace_id=${workspaceId} AND s.id IN ${db(ids)} AND s.upload_state='uploaded'
        AND EXISTS (SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=s.version)
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${workspaceId} AND e.source_id=s.id)`;
    if (Number(admitted?.n ?? 0) !== ids.length) return { kind: "skip", reason: "skipped_source_unavailable" };
  }
  return { kind: "record", courseId: card.courseId, sourceIds: ids };
}
