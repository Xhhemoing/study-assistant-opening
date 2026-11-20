import { retainBackupEventChains, type NativeBackupSnapshot } from "@aistudy/domain/native";
import { asObject } from "./backup-map";
import { backupPrivateLibrary } from "./backup-private-library";
import { parseBackupSourceRefs } from "./backup-publication-provenance";
import type { NativeTeachingOrigins } from "./native-backup-teaching";
import { excludedTeachingDocumentIds } from "./opening-backup-library";

type NativeLibrary = Pick<NativeBackupSnapshot,
  "documents" | "blocks" | "revisions" | "relations" | "memberships" | "cards" | "events" | "promotions">;
type Records<T> = { [Key in keyof NativeLibrary]: T[] };

export function projectNativeBackupLibrary<T extends Record<string, unknown>>(records: Records<T>, privateDocuments: string[],
  privateBlockIds: unknown[], includedSources: ReadonlySet<string>, teachingSpecs: Record<string, unknown>[] = [],
  origins?: NativeTeachingOrigins) {
  const excludedDocuments = [...privateDocuments, ...excludedTeachingDocumentIds(teachingSpecs, includedSources)];
  for (const doc of records.documents) {
    const refs = parseBackupSourceRefs(asObject(doc.openingProvenance)?.contextSourceRefs);
    if (typeof doc.id === "string" && refs?.some(ref => ref.publication && !includedSources.has(ref.sourceId))) {
      excludedDocuments.push(doc.id);
    }
  }
  const library = backupPrivateLibrary(records.documents, records.blocks, records.revisions, "documentId", excludedDocuments, privateBlockIds, includedSources);
  const deletedDocs = new Set(records.documents.filter(row => row.deletedAt != null).map(row => row.id));
  const blockedCards = new Set(records.cards.filter(row => {
    const origin = origins?.get(String(row.originObservationRootId).toLowerCase());
    return !library.documentAllowed(row.sourceDocumentId) || origin?.privateExam
      || origin?.sourceIds.some(id => !includedSources.has(id))
      || origin?.documentIds.some(id => !library.documentAllowed(id))
      || Array.isArray(row.originTeachingDocumentIds) && row.originTeachingDocumentIds.some(id => deletedDocs.has(id) || !library.documentAllowed(id));
  }).map(row => row.id));
  const keep = (id: unknown) => library.assetAllowed(id) && !blockedCards.has(id);
  return {
    fileAllowed: library.fileAllowed,
    records: {
      documents: library.documents,
      blocks: library.blocks,
      revisions: library.revisions,
      relations: records.relations.filter(row => keep(row.fromId) && keep(row.toId)),
      memberships: records.memberships.filter(row => keep(row.assetId)),
      cards: records.cards.filter(row => !blockedCards.has(row.id)),
      events: retainBackupEventChains(records.events.filter(row => keep(row.contentId)), "correctsEventId"),
      promotions: records.promotions.filter(row => keep(row.targetId)).map(row => Array.isArray(row.targets)
        ? { ...row, targets: row.targets.filter(target => keep(target?.targetId)) } : row),
    },
  };
}
