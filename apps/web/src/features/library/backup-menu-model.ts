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
    headline: "原生内容备份（库内范围）",
    disclaimer: "可恢复原生笔记与修订、课程与目标、旧版探索记录、卡片及复习状态；附件仅包含笔记内已嵌入的数据。不包含材料原件（S3）、Opening 学习记录与观测、助理对话与记忆、练习尝试与补测、任务与计划、连接凭据和工作区偏好。本路径不是完整工作区恢复；Opening 备份另按约定范围保存学习数据，暂不包含学习测试记录。学习测试进度恢复需要管理员的完整数据库备份；测试 JSON 仅供分析，不能恢复进度。",
    restoreHint: "请在兼容版本恢复，并选择冲突策略：拒绝或跳过；不会覆盖已有记录。关联材料的片段笔记仅支持在原工作区、来源仍可用且未受限时恢复。",
    resultSummary: warningCount === 0
      ? "原生内容恢复已完成，没有跳过冲突记录。"
      : `原生内容恢复已完成，有 ${warningCount} 项因 ID 冲突被跳过。`,
  };
}
