import { findForbiddenBackupTable } from "../../../contracts/src/opening/backup-inventory";
import { BackupRestoreError } from "./backup-types";
import { assertNativeCardRestorePrivacy, assertNativeNoteRestorePrivacy } from "./native-note-privacy";
import type { Sql } from "postgres";
import { listMigrationFiles } from "../migrate";
import { planNativeRestore } from "@aistudy/domain/native";
import { dumpWorkspaceSnapshot, snapshotToPackage, assertBackupWorkspaceOwner } from "./backup-dump";
import { applyRestorePlan, loadExistingIds } from "./backup-insert";
import { wrapBackupError } from "./backup-map";
import type { BackupRestoreRepository } from "./backup-types";

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
          const existingIds = await loadExistingIds(tx as Sql, input.packed, input.workspaceId);
          const plan = planNativeRestore({
            packed: input.packed,
            targetWorkspaceId: input.workspaceId,
            targetOwnerUserId: input.ownerUserId,
            existingIds,
            conflictPolicy: input.conflictPolicy,
            compatibleMigrationIds,
          });
          await assertNativeNoteRestorePrivacy(tx as unknown as Sql, input.workspaceId, input.packed);
          await assertNativeCardRestorePrivacy(tx as unknown as Sql, input.workspaceId, input.packed);
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
