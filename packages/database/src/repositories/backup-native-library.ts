import type { NativeBackupSnapshot } from "@aistudy/domain/native";
import { backupPrivateLibrary } from "./backup-private-library";
import { excludedTeachingDocumentIds } from "./opening-backup-library";

type NativeLibrary = Pick<NativeBackupSnapshot,
  "documents" | "blocks" | "revisions" | "relations" | "memberships" | "cards" | "events" | "promotions">;
type Records<T> = { [Key in keyof NativeLibrary]: T[] };

export function projectNativeBackupLibrary<T extends Record<string, unknown>>(records: Records<T>, privateDocuments: string[],
  privateBlockIds: unknown[], includedSources: ReadonlySet<string>, teachingSpecs: Record<string, unknown>[] = []) {
  const excludedDocuments = [...privateDocuments, ...excludedTeachingDocumentIds(teachingSpecs, includedSources)];
  const library = backupPrivateLibrary(records.documents, records.blocks, records.revisions, "documentId", excludedDocuments, privateBlockIds, includedSources);
  const blockedCards = new Set(records.cards.filter(row => !library.documentAllowed(row.sourceDocumentId)).map(row => row.id));
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
      events: records.events.filter(row => keep(row.contentId)),
      promotions: records.promotions.filter(row => keep(row.targetId)).map(row => Array.isArray(row.targets)
        ? { ...row, targets: row.targets.filter(target => keep(target?.targetId)) } : row),
    },
  };
}
