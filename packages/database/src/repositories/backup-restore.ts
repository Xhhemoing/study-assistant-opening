import { assertNativeNoteRestorePrivacy } from "./native-note-privacy";
import type { Sql } from "postgres";
import { listMigrationFiles } from "../migrate";
import { planNativeRestore } from "@aistudy/domain/native";
import { dumpWorkspaceSnapshot, snapshotToPackage, assertBackupWorkspaceOwner } from "./backup-dump";
import { applyRestorePlan, loadExistingIds } from "./backup-insert";
import { wrapBackupError } from "./backup-map";
import type { BackupRestoreRepository } from "./backup-types";

export {
  BackupRestoreError,
  type BackupRestoreErrorCode,
  type BackupRestoreRepository,
} from "./backup-types";

export function createBackupRestoreRepository(sql: Sql): BackupRestoreRepository {
  return {
    async exportWorkspace(input) {
      return sql.begin(async tx => {
        await tx`SELECT id FROM workspaces WHERE id=${input.workspaceId} AND owner_user_id=${input.ownerUserId} FOR UPDATE`;
        const snapshot = await dumpWorkspaceSnapshot(tx as unknown as Sql, input.workspaceId, input.ownerUserId);
        return snapshotToPackage(snapshot);
      });
    },

    async restoreWorkspace(input) {
      await assertBackupWorkspaceOwner(sql, input.workspaceId, input.ownerUserId);
      try {
        const compatibleMigrationIds = await listMigrationFiles();
        const existingIds = await loadExistingIds(sql, input.packed);
        const plan = planNativeRestore({
          packed: input.packed,
          targetWorkspaceId: input.workspaceId,
          targetOwnerUserId: input.ownerUserId,
          existingIds,
          conflictPolicy: input.conflictPolicy,
          compatibleMigrationIds,
        });
        await sql.begin(async (tx) => {
          await tx`SELECT id FROM workspaces WHERE id=${input.workspaceId} AND owner_user_id=${input.ownerUserId} FOR UPDATE`;
          await assertBackupWorkspaceOwner(tx as unknown as Sql, input.workspaceId, input.ownerUserId);
          await assertNativeNoteRestorePrivacy(tx as unknown as Sql, input.workspaceId, input.packed);
          await applyRestorePlan(tx as Sql, plan);
        });
        return {
          conflictPolicy: input.conflictPolicy,
          applied: plan.applied,
          skipped: plan.skipped,
          warnings: plan.warnings,
        };
      } catch (error) {
        wrapBackupError(error);
      }
    },
  };
}
