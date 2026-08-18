import type { Sql } from "postgres";
import { listMigrationFiles } from "../migrate";
import { planNativeRestore } from "@aistudy/domain";
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
      const snapshot = await dumpWorkspaceSnapshot(sql, input.workspaceId, input.ownerUserId);
      return snapshotToPackage(snapshot);
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
