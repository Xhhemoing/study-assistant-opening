import type {
  AttemptEvent,
  Diagnostics,
  ErrorCause,
  StatusResult,
  StatusWord,
} from "@aistudy/contracts";
import { planIntervention } from "@aistudy/domain";

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

export interface InterventionSummary {
  actionLabel: string;
  priorityLabel: string;
  checkAtLabel: string;
}

const ACTION_LABELS: Record<"review" | "variant" | "schedule", string> = {
  review: "复习巩固",
  variant: "做一道变式",
  schedule: "安排限时复习",
};

const PRIORITY_LABELS: Record<"low" | "medium" | "high", string> = {
  low: "常规",
  medium: "重点关注",
  high: "优先处理",
};

/**
 * 根据本次错误与该考点历史错误生成干预摘要；答对或无错因时返回 null。
 */
export function buildInterventionSummary(
  event: AttemptEvent,
  history: AttemptEvent[],
): InterventionSummary | null {
  if (event.correct || !event.errorCause) return null;
  const historyCauses: ErrorCause[] = history
    .filter(
      (item) =>
        item.id !== event.id &&
        item.syllabusPointId === event.syllabusPointId &&
        !item.correct &&
        item.errorCause !== null,
    )
    .map((item) => item.errorCause as ErrorCause);
  const plan = planIntervention({
    cause: event.errorCause,
    confidence: event.confidence,
    occurredAt: event.createdAt,
    historyCauses,
  });
  return {
    actionLabel: ACTION_LABELS[plan.action],
    priorityLabel: PRIORITY_LABELS[plan.priority],
    checkAtLabel: plan.checkAt.slice(0, 10),
  };
}
