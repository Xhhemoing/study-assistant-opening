import { uuidSchema } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { isPrivateExamActivity } from "./opening-backup-library";
import { withPublicationCardSourceIds } from "./card-sources";
import type { BackupSourceRef } from "./backup-publication-provenance";

type Row = Record<string, unknown>;

type TeachingOrigin = { documentIds: string[]; sourceIds: string[]; privateExam: boolean };
export type NativeTeachingOrigins = ReadonlyMap<string, TeachingOrigin>;

export async function readNativeTeachingOrigins(
  sql: Sql | TransactionSql, workspaceId: string, cards: Row[], privateExams: string[],
): Promise<NativeTeachingOrigins> {
  const observationIds = [...new Set(cards.flatMap(card =>
    uuidSchema.safeParse(card.originObservationRootId).data?.toLowerCase() ?? []))];
  if (!observationIds.length) return new Map();
  const rows = await sql<{ id: string; document_ids: string[]; source_ids: string[]; private_exam: boolean }[]>`
    SELECT o.id, a.source_ids, array_remove(ARRAY[spec.document_id, unit.document_id], NULL) AS document_ids,
      ${isPrivateExamActivity(sql, privateExams)} AS private_exam
    FROM opening_learning_observations o
    JOIN opening_teaching_activities a ON a.id=o.activity_id AND a.workspace_id=o.workspace_id
    LEFT JOIN opening_teaching_activity_specs spec ON spec.activity_id=a.id AND spec.workspace_id=a.workspace_id
    LEFT JOIN opening_teaching_units unit ON unit.id=spec.teaching_unit_id AND unit.workspace_id=a.workspace_id
    WHERE o.workspace_id=${workspaceId} AND o.id=ANY(${observationIds}::uuid[])`;
  return new Map(rows.map(row => [row.id, {
    documentIds: row.document_ids, sourceIds: row.source_ids, privateExam: row.private_exam,
  }]));
}

export function attachNativeTeachingOrigins<T extends Row>(cards: T[], origins: NativeTeachingOrigins,
  historicalDocuments: ReadonlyMap<string, string[]>): T[] {
  return cards.map(card => {
    if (card.originObservationRootId == null) return card;
    const origin = origins.get(String(card.originObservationRootId).toLowerCase());
    const archived = Array.isArray(card.originTeachingDocumentIds) ? card.originTeachingDocumentIds : [];
    const documentIds = [...new Set([...archived, ...(origin?.documentIds ?? []),
      ...(historicalDocuments.get(String(card.id).toLowerCase()) ?? [])])];
    return documentIds.length ? { ...card, originTeachingDocumentIds: documentIds } : card;
  });
}

export function attachNativeCardPublicationSources<T extends Row>(
  cards: T[], publications: ReadonlyMap<string, readonly BackupSourceRef[]>,
): T[] {
  return cards.map(card => {
    if (card.originObservationRootId == null) return card;
    const documents = [...(Array.isArray(card.originTeachingDocumentIds) ? card.originTeachingDocumentIds : []), card.sourceDocumentId];
    const sourceIds = documents.flatMap(id =>
      (publications.get(String(id).toLowerCase()) ?? []).filter(ref => ref.publication).map(ref => ref.sourceId));
    return { ...card, sourceIds: withPublicationCardSourceIds(card.sourceIds, sourceIds) };
  });
}
