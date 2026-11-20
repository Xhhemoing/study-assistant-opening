import { uuidSchema } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { asObject } from "./backup-map";
import { parseContextSourceRefs, type ContextSourceRef } from "./opening-context-provenance";
import { isPrivateExamActivity } from "./opening-backup-library";

type Row = Record<string, unknown>;
type PublicationSourceRef = ContextSourceRef & { publication: true };
export type BackupSourceRef = ContextSourceRef & { publication?: true };

// The existing provenance JSON also persists publication lineage across native restores.
export function parseBackupSourceRefs(value: unknown): BackupSourceRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs = parseContextSourceRefs(value);
  if (!refs) return null;
  const publicationRefs = new Set(parseContextSourceRefs(value
    .filter(ref => asObject(ref)?.publication === true))?.map(ref => `${ref.sourceId}:${ref.sourceVersion}`));
  return refs.map(ref => publicationRefs.has(`${ref.sourceId}:${ref.sourceVersion}`)
    ? { ...ref, publication: true } : ref);
}

export function publicationSourceRefsByDocument(specs: Row[], sourceVersions: ReadonlyMap<string, number>) {
  const documents = new Map<string, PublicationSourceRef[]>();
  for (const spec of specs) {
    if (typeof spec.document_id !== "string" || !Array.isArray(spec.source_refs)) continue;
    const refs = documents.get(spec.document_id) ?? [];
    for (const value of spec.source_refs) {
      const citation = asObject(value);
      if (typeof citation?.sourceId !== "string") continue;
      const sourceId = citation.sourceId.toLowerCase();
      const currentVersion = sourceVersions.get(sourceId);
      if (currentVersion === undefined) continue;
      const rawVersion = citation.version ?? citation.sourceVersion;
      const version = typeof rawVersion === "string" && /^\d+$/.test(rawVersion) ? Number(rawVersion) : rawVersion;
      const sourceVersion = typeof version === "number" && Number.isSafeInteger(version) && version >= 0
        ? version : currentVersion;
      refs.push({ sourceId, sourceVersion, publication: true });
    }
    documents.set(spec.document_id, refs);
  }
  return documents;
}

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

export function attachNativeTeachingOrigins<T extends Row>(cards: T[], origins: NativeTeachingOrigins): T[] {
  return cards.map(card => {
    const origin = origins.get(String(card.originObservationRootId));
    const documentIds = origin ? [...new Set(origin.documentIds)] : [];
    return documentIds.length ? { ...card, originTeachingDocumentIds: documentIds } : card;
  });
}
