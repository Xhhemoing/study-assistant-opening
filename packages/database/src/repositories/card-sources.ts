import type { Sql, TransactionSql } from "postgres";
import { CardRepositoryError } from "./cards-types";
import { noteContextSourceRefsIncluded, parseNoteContextSourceRefs } from "./opening-context-provenance";

type Db = Sql | TransactionSql;
/** Identity-based lineage remains private after source exclusion/deletion, including historical text. */
export function cardSourcesIncluded(db: Db, workspaceId: string, ids: ReturnType<Db>) {
  return db`COALESCE(${ids}::uuid[], '{}'::uuid[]) <@ ARRAY(
    SELECT s.id FROM opening_sources s
    WHERE s.workspace_id=${workspaceId} AND s.upload_state='uploaded'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${workspaceId} AND e.source_id=s.id)
  )`;
}
/** Extract normalized publication card IDs from any depth without recursive CTE planner fanout. */
export function notePublicationCardIds(db: Db, refs: () => ReturnType<Db>) {
  return db`(SELECT DISTINCT lower(btrim(linked.id)) AS card_id
    FROM (SELECT ${refs()} AS val) AS root
    CROSS JOIN LATERAL unnest(ARRAY(
      SELECT jsonb_array_elements(
        CASE WHEN root.val IS NOT NULL AND COALESCE(jsonb_path_exists(root.val, '$.**.publicationCardIds'), false)
          THEN jsonb_path_query_array(
            jsonb_path_query_array(jsonb_build_array(root.val), 'strict $.**.publicationCardIds', '{}'::jsonb, true),
            'lax $[*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*][*]'::jsonpath
          )
          ELSE '[]'::jsonb
        END
      )
    )) AS leaf(val)
    CROSS JOIN LATERAL (
      VALUES
        (CASE WHEN jsonb_typeof(leaf.val)='string' THEN leaf.val #>> '{}' END),
        (CASE WHEN jsonb_typeof(leaf.val)='object' AND jsonb_typeof(leaf.val->'id')='string' THEN leaf.val->>'id' END),
        (CASE WHEN jsonb_typeof(leaf.val)='object' AND jsonb_typeof(leaf.val->'cardId')='string' THEN leaf.val->>'cardId' END)
    ) AS linked(id)
    WHERE root.val IS NOT NULL
      AND COALESCE(jsonb_path_exists(root.val, '$.**.publicationCardIds'), false)
      AND linked.id IS NOT NULL AND btrim(linked.id)<>'')`;
}

/** Historical publication links survive reassignment of the card or its teaching spec. */
export function cardLinkedToNotePublication(db: Db) {
  return db`(COALESCE(jsonb_path_exists(np.context_source_refs, '$.**.publicationCardIds'), false)
    AND EXISTS (
      SELECT 1 FROM ${notePublicationCardIds(db, () => db`np.context_source_refs`)} AS pub(card_id)
      WHERE pub.card_id=c.id::text
    ))`;
}

export function cardReadable(db: Db, workspaceId: string) {
  return db`${cardSourcesIncluded(db, workspaceId, db`c.source_ids`)}
    AND (c.source_document_id IS NULL OR EXISTS (SELECT 1 FROM library_documents d WHERE d.id=c.source_document_id AND d.workspace_id=${workspaceId}))
    AND NOT EXISTS (SELECT 1 FROM opening_note_provenance np WHERE np.document_id=c.source_document_id
      AND (np.workspace_id<>${workspaceId} OR NOT (${noteContextSourceRefsIncluded(db, workspaceId, () => db`np.context_source_refs`, true)})))
    AND NOT COALESCE(c.id::text = ANY(ARRAY(
      SELECT pub.card_id
      FROM (
        SELECT np.document_id, np.workspace_id, np.context_source_refs
        FROM opening_note_provenance np
        WHERE np.context_source_refs IS NOT NULL
          AND COALESCE(jsonb_path_exists(np.context_source_refs, '$.**.publicationCardIds'), false)
      ) np
      LEFT JOIN library_documents d ON d.id=np.document_id AND d.workspace_id=np.workspace_id
      CROSS JOIN LATERAL ${notePublicationCardIds(db, () => db`np.context_source_refs`)} AS pub(card_id)
      WHERE np.workspace_id<>${workspaceId} OR d.id IS NULL OR d.deleted_at IS NOT NULL
        OR NOT (${noteContextSourceRefsIncluded(db, workspaceId, () => db`np.context_source_refs`, true)})
    )), false)`;
}

export function withPublicationCardSourceIds(existing: unknown, publicationIds: Iterable<string>) {
  if (!Array.isArray(existing)) return existing;
  return [...new Set([...existing, ...publicationIds])];
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
  const refs = row.provenance_id ? parseNoteContextSourceRefs(row.context_source_refs) : [];
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
