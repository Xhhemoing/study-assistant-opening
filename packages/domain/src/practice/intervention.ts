import type { ErrorCause, PracticeItem } from "@aistudy/contracts";

export type InterventionAction = "review" | "variant" | "schedule";
export type InterventionPriority = "low" | "medium" | "high";

export interface InterventionHint {
  message: string;
  action: InterventionAction;
}

export interface InterventionPlan {
  cause: ErrorCause | null;
  action: InterventionAction;
  priority: InterventionPriority;
  /** 干预效果检查时间（7 天干预窗口）。 */
  checkAt: string;
  strategyVersion: string;
}

export const INTERVENTION_VERSION = "intervention-1";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 高信心错误（confidence >= 4）提示稳定的误解风险。 */
const HIGH_CONFIDENCE_THRESHOLD = 4;

function shortStem(stem: string, max = 12): string {
  return stem.length > max ? `${stem.slice(0, max)}…` : stem;
}

/** 错因 → 干预动作的固定映射，供单次分类与干预计划共用。 */
export function actionForCause(cause: ErrorCause | null): InterventionAction {
  if (!cause) return "review";
  switch (cause) {
    case "calculation":
      return "variant";
    case "time":
      return "schedule";
    default:
      return "review";
  }
}

/**
 * Deterministic error classification for Phase 1.
 * Returns a human-readable hint and a suggested next action based on the reported cause.
 */
export function classifyError(cause: ErrorCause | null, item: PracticeItem): InterventionHint {
  const action = actionForCause(cause);
  if (!cause) {
    return { message: "请回顾题目涉及的核心概念。", action };
  }
  switch (cause) {
    case "concept":
      return { message: `「${shortStem(item.stem)}」涉及的概念定义需要再巩固。`, action };
    case "misread":
      return { message: "请仔细阅读题干，避免遗漏限定条件。", action };
    case "calculation":
      return { message: "计算过程出现偏差，建议再做一道同类变式。", action };
    case "steps":
      return { message: "解题步骤不完整，建议复盘标准解法。", action };
    case "time":
      return { message: "限时练习不足，建议安排 3 天后复习卡。", action };
    case "other":
    default:
      return { message: "本次错误已记录，建议稍后复习同类题目。", action };
  }
}

/**
 * 生成干预计划（规则候选，无需 AI）：
 * - 错因 → 动作（复用 actionForCause）；
 * - 同一错误重复出现 → 高优先级；
 * - 高信心错误（confidence >= 4）→ 中优先级（稳定误解风险）；
 * - 7 天干预窗口：checkAt = occurredAt + 7 天。
 */
export function planIntervention(input: {
  cause: ErrorCause | null;
  confidence: number;
  occurredAt: string;
  historyCauses?: ErrorCause[];
}): InterventionPlan {
  const { cause, confidence, occurredAt } = input;
  const action = actionForCause(cause);
  const repeated = cause !== null && (input.historyCauses ?? []).includes(cause);
  const highConfidence = confidence >= HIGH_CONFIDENCE_THRESHOLD;
  const priority: InterventionPriority = repeated ? "high" : highConfidence ? "medium" : "low";
  const occurredMs = Date.parse(occurredAt);
  const checkAt = Number.isFinite(occurredMs)
    ? new Date(occurredMs + 7 * DAY_MS).toISOString()
    : occurredAt;
  return { cause, action, priority, checkAt, strategyVersion: INTERVENTION_VERSION };
}
