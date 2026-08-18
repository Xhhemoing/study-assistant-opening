import type { BackupConflictPolicy, NativeBackupPackage } from "@aistudy/contracts";

export function buildBackupExportRequest(): Record<string, never> {
  return {};
}

export function buildBackupRestoreRequest(
  packed: NativeBackupPackage,
  conflictPolicy: BackupConflictPolicy,
): { conflictPolicy: BackupConflictPolicy; package: NativeBackupPackage } {
  return { conflictPolicy, package: packed };
}

export function backupCopy(warningCount = 0): {
  headline: string;
  disclaimer: string;
  restoreHint: string;
  resultSummary: string;
} {
  return {
    headline: "完整备份",
    disclaimer: "原生备份可在兼容版本恢复。冲突 ID 不会覆盖现有数据。",
    restoreHint: "恢复前必须选择冲突策略：拒绝或跳过。系统不会覆盖已有记录。",
    resultSummary: warningCount === 0
      ? "恢复已完成，没有跳过冲突记录。"
      : `恢复已完成，有 ${warningCount} 项因 ID 冲突被跳过。`,
  };
}
