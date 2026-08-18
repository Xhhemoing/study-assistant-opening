import {
  backupExportRequestSchema,
  backupRestoreRequestSchema,
  type BackupExportResponse,
  type BackupRestoreResponse,
} from "@aistudy/contracts";
import type { Principal } from "../../lib/authorization";
import type { AuthRuntime } from "../auth/service";

export async function exportBackupForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<BackupExportResponse> {
  backupExportRequestSchema.parse(body ?? {});
  const packed = await runtime.backups.exportWorkspace({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
  });
  return { format: "aistudy-native", package: packed };
}

export async function restoreBackupForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
): Promise<BackupRestoreResponse> {
  const parsed = backupRestoreRequestSchema.parse(body ?? {});
  return runtime.backups.restoreWorkspace({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    packed: parsed.package,
    conflictPolicy: parsed.conflictPolicy,
  });
}
