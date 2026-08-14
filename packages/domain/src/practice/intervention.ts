import type { ErrorCause, PracticeItem } from "@aistudy/contracts";

export interface InterventionHint {
  message: string;
  action: "review" | "variant" | "schedule";
}

/**
 * Deterministic error classification for Phase 1.
 * Returns a human-readable hint and a suggested next action based on the reported cause.
 */
export function classifyError(cause: ErrorCause | null, item: PracticeItem): InterventionHint {
  if (!cause) {
    return { message: "请回顾题目涉及的核心概念。", action: "review" };
  }
  switch (cause) {
    case "concept":
      return { message: `「${item.stem.slice(0, 12)}…」涉及的概念定义需要再巩固。`, action: "review" };
    case "misread":
      return { message: "请仔细阅读题干，避免遗漏限定条件。", action: "review" };
    case "calculation":
      return { message: "计算过程出现偏差，建议再做一道同类变式。", action: "variant" };
    case "steps":
      return { message: "解题步骤不完整，建议复盘标准解法。", action: "review" };
    case "time":
      return { message: "限时练习不足，建议安排 3 天后复习卡。", action: "schedule" };
    case "other":
    default:
      return { message: "本次错误已记录，建议稍后复习同类题目。", action: "review" };
  }
}
