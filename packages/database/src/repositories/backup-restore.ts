import { findForbiddenBackupTable } from "../../../contracts/src/opening/backup-inventory";
import { BackupRestoreError } from "./backup-types";
import { assertNativeCardRestorePrivacy, assertNativeNoteRestorePrivacy, readNoteBackupProvenance } from "./native-note-privacy";
import type { Sql } from "postgres";
import { listMigrationFiles } from "../migrate";
import { assertFileHashes, planNativeRestore } from "@aistudy/domain/native";
import { dumpWorkspaceSnapshot, snapshotToPackage, assertBackupWorkspaceOwner } from "./backup-dump";
import { applyRestorePlan, loadExistingIds } from "./backup-insert";
import { asRecords, wrapBackupError } from "./backup-map";
import type { BackupRestoreRepository } from "./backup-types";
import { privateExamDocumentIds, readBackupAnswerBlockIds, readBackupLibrarySourceVersions, readBackupTeachingSourceRefs } from "./opening-backup-library";
import { projectNativeBackupLibrary } from "./backup-native-library";
import { attachNativeCardPublicationSources, attachNativeTeachingOrigins, publicationSourceRefsByDocument, readNativeTeachingOrigins, type BackupSourceRef } from "./native-backup-teaching";

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
          const [privateBlocks, sourceVersions, teachingSpecs, origins] = await Promise.all([
            readBackupAnswerBlockIds(tx, input.workspaceId),
            sameWorkspace ? readBackupLibrarySourceVersions(tx, input.workspaceId) : undefined,
            sameWorkspace ? readBackupTeachingSourceRefs(tx, input.workspaceId) : [],
            sameWorkspace ? readNativeTeachingOrigins(tx, input.workspaceId, input.packed.records.cards, privateExams) : undefined,
          ]);
          const inputRecords = input.packed.records;
          const cards = origins ? attachNativeTeachingOrigins(inputRecords.cards, origins) : inputRecords.cards;
          const library = projectNativeBackupLibrary({ ...inputRecords, cards }, privateExams, privateBlocks,
            new Set(sourceVersions?.keys()), teachingSpecs, origins);
          const files = input.packed.files.filter(file => library.fileAllowed(file.path));
          if (files.length !== input.packed.files.length) assertFileHashes(input.packed.files);
          // Older archives only carried the document IDs. Resolve their provenance before the
          // insert so it survives even when the destination has no teaching spec.
          const publications: Map<string, BackupSourceRef[]> = publicationSourceRefsByDocument(teachingSpecs, sourceVersions ?? new Map());
          for (const document of asRecords(library.records.documents)) {
            const id = document.id.toLowerCase();
            const refs = readNoteBackupProvenance(document, false)?.contextSourceRefs;
            if (refs) publications.set(id, [...(publications.get(id) ?? []), ...refs.filter(ref => ref.publication)]);
          }
          const restoredCards = attachNativeCardPublicationSources(library.records.cards, publications);
          const packed = { ...input.packed, records: { ...inputRecords, ...library.records, cards: restoredCards }, files };
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
          await assertNativeCardRestorePrivacy(tx as unknown as Sql, input.workspaceId, packed);
          await applyRestorePlan(tx as Sql, plan);
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
