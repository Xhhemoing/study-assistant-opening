import { findForbiddenBackupTable } from "../../../contracts/src/opening/backup-inventory";
import { BackupRestoreError } from "./backup-types";
import { assertNativeCardRestorePrivacy, assertNativeNoteRestorePrivacy, readNoteBackupProvenance, retainNativeRestoreProvenance } from "./native-note-privacy";
import type { Sql } from "postgres";
import { listMigrationFiles } from "../migrate";
import { assertFileHashes, planNativeRestore } from "@aistudy/domain/native";
import { dumpWorkspaceSnapshot, snapshotToPackage, assertBackupWorkspaceOwner } from "./backup-dump";
import { applyRestorePlan, loadExistingIds } from "./backup-insert";
import { asRecords, wrapBackupError } from "./backup-map";
import type { BackupRestoreRepository } from "./backup-types";
import { privateExamDocumentIds, readBackupLibrarySourceVersions, readBackupNoteProvenance, readBackupTeachingSourceRefs } from "./opening-backup-library";
import { projectNativeBackupLibrary } from "./backup-native-library";
import { attachNativeCardPublicationSources, attachNativeTeachingOrigins, readNativeTeachingOrigins } from "./native-backup-teaching";
import { historicalTeachingDocumentsByCard, parseBackupSourceRefs, publicationAnswerKeysByDocument, publicationSourceRefsByDocument, type BackupSourceRef } from "./backup-publication-provenance";

// This entrypoint is also re-exported by the database package's public barrel.
export { BACKUP_FORBIDDEN_TABLES, EXPLICIT_NON_EXPORTED_WORKSPACE_TABLES } from "./opening-backup-empty-namespace";
export {
  BackupRestoreError,
  type BackupRestoreErrorCode,
  type BackupRestoreRepository,
} from "./backup-types";

export function createBackupRestoreRepository(sql: Sql): BackupRestoreRepository {
  return {
    async exportWorkspace(input) {
      // Native privacy writers share this owner lock. A read-only transaction cannot take it.
      return sql.begin("isolation level repeatable read", async tx => {
        await tx`SELECT id FROM workspaces WHERE id=${input.workspaceId} AND owner_user_id=${input.ownerUserId} FOR UPDATE`;
        const snapshot = await dumpWorkspaceSnapshot(tx as unknown as Sql, input.workspaceId, input.ownerUserId);
        return snapshotToPackage(snapshot);
      });
    },

    async restoreWorkspace(input) {
      const forbidden = findForbiddenBackupTable(input.packed);
      if (forbidden) throw new BackupRestoreError("VALIDATION", `Forbidden backup table: ${forbidden}`);
      await assertBackupWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      try {
        const compatibleMigrationIds = await listMigrationFiles();
        return await sql.begin(async (tx) => {
          await tx`SELECT id FROM workspaces WHERE id=${input.workspaceId} AND owner_user_id=${input.ownerUserId} FOR UPDATE`;
          await assertBackupWorkspaceOwner(tx as unknown as Sql, input.workspaceId, input.ownerUserId);
          const privateExams = await privateExamDocumentIds(tx, input.workspaceId);
          const sameWorkspace = input.packed.sourceWorkspaceId === input.workspaceId;
          const [noteProvenance, sourceVersions, teachingSpecs, origins] = await Promise.all([
            readBackupNoteProvenance(tx, input.workspaceId),
            sameWorkspace ? readBackupLibrarySourceVersions(tx, input.workspaceId) : undefined,
            readBackupTeachingSourceRefs(tx, input.workspaceId),
            sameWorkspace ? readNativeTeachingOrigins(tx, input.workspaceId, input.packed.records.cards, privateExams) : undefined,
          ]);
          const inputRecords = input.packed.records;
          const cards = origins ? attachNativeTeachingOrigins(inputRecords.cards, origins, historicalTeachingDocumentsByCard(noteProvenance)) : inputRecords.cards;
          const answerKeys = publicationAnswerKeysByDocument(teachingSpecs, noteProvenance);
          const incomingNotes = new Map(asRecords(inputRecords.documents).map(document => [document.id, readNoteBackupProvenance(document, false)]));
          const privateBlocks = [...[...answerKeys.values()].flat(), ...[...incomingNotes.values()].flatMap(note => note?.answerKeyBlockIds ?? [])];
          const currentSpecs = sameWorkspace ? teachingSpecs : [];
          const library = projectNativeBackupLibrary({ ...inputRecords, cards }, privateExams, privateBlocks,
            new Set(sourceVersions?.keys()), currentSpecs, origins);
          const files = input.packed.files.filter(file => library.fileAllowed(file.path));
          if (files.length !== input.packed.files.length) assertFileHashes(input.packed.files);
          // Older archives only carried the document IDs. Resolve their provenance before the
          // insert so it survives even when the destination has no teaching spec.
          const currentPublications = publicationSourceRefsByDocument(currentSpecs, sourceVersions ?? new Map());
          const publications: Map<string, BackupSourceRef[]> = new Map(currentPublications);
          for (const row of noteProvenance) {
            const id = String(row.document_id).toLowerCase();
            const refs = parseBackupSourceRefs(row.context_source_refs)?.filter(ref => ref.publication) ?? [];
            if (refs.length) publications.set(id, [...(publications.get(id) ?? []), ...refs]);
          }
          const documents = library.records.documents.map(document => {
            const id = String(document.id).toLowerCase();
            const note = incomingNotes.get(String(document.id));
            const currentRefs = currentPublications.get(id) ?? [];
            const refs = parseBackupSourceRefs([...(note?.contextSourceRefs ?? []), ...currentRefs])!;
            if (refs.length) publications.set(id, [...(publications.get(id) ?? []), ...refs.filter(ref => ref.publication)]);
            const keys = [...new Set([...(note?.answerKeyBlockIds ?? []), ...(sameWorkspace ? answerKeys.get(id) ?? [] : [])])];
            return note || refs.length || keys.length ? { ...document, openingProvenance: {
              contextSourceRefs: refs, ...(keys.length > 0 && { answerKeyBlockIds: keys }),
            } } : document;
          });
          const restoredCards = attachNativeCardPublicationSources(library.records.cards, publications);
          const packed = { ...input.packed, records: { ...inputRecords, ...library.records, documents, cards: restoredCards }, files };
          const existingIds = await loadExistingIds(tx as Sql, packed, input.workspaceId);
          const plan = planNativeRestore({
            packed,
            targetWorkspaceId: input.workspaceId,
            targetOwnerUserId: input.ownerUserId,
            existingIds,
            conflictPolicy: input.conflictPolicy,
            compatibleMigrationIds,
          });
          await assertNativeNoteRestorePrivacy(tx as unknown as Sql, input.workspaceId, packed);
          await assertNativeCardRestorePrivacy(tx as unknown as Sql, input.workspaceId, packed, existingIds);
          await applyRestorePlan(tx as Sql, plan);
          await retainNativeRestoreProvenance(tx as Sql, input.workspaceId, packed, existingIds);
          return {
            conflictPolicy: input.conflictPolicy,
            applied: plan.applied,
            skipped: plan.skipped,
            warnings: plan.warnings,
          };
        });
      } catch (error) {
        wrapBackupError(error);
      }
    },
  };
}
