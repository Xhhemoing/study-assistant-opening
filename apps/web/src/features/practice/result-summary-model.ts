import type {
  AttemptEvent,
  Diagnostics,
  StatusResult,
  StatusWord,
} from "@aistudy/contracts";

const statusLabels: Record<StatusWord, string> = {
  stable: "稳固",
  usable: "可用",
  weak: "薄弱",
  untested: "未测",
};

const reasonLabels: Record<string, string> = {
  "recent-failure": "最近一次作答没有答对",
  "low-confidence": "这几次作答的信心偏低",
  "hint-dependent": "近期对提示的依赖较高",
  "insufficient-evidence": "有效证据还不够",
  "consistent-success": "近期连续答对且包含迁移题",
  "partial-mastery": "部分能力已经稳定，仍有边界需要巩固",
  "user-correction": "你已手动修正这个状态",
  "user-disputed": "你标记过这个判断不准确",
};

export function statusWordLabel(status: StatusWord): string {
  return statusLabels[status];
}

export function reasonCodeLabel(code: string): string {
  return reasonLabels[code] ?? "系统记录的状态原因";
}

export function getAttemptEvidenceLabel(event: AttemptEvent): string {
  if (event.assisted) return "看过答案，本次不计入独立有效证据";
  return event.correct ? "本次作答已计入有效证据" : "本次作答已记录，可用于调整下一步";
}

export interface PracticeResultData {
  event: AttemptEvent;
  status: StatusResult | null;
}

export function findPracticeResult(
  diagnostics: Diagnostics,
  eventId: string,
): PracticeResultData | null {
  const event = diagnostics.recentAttemptEvents.find((item) => item.id === eventId);
  if (!event) return null;
  return {
    event,
    status: diagnostics.statuses.find((item) => item.syllabusPointId === event.syllabusPointId) ?? null,
  };
}
