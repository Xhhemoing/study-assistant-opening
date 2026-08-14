import type { PracticeItem } from "@aistudy/contracts";
import type { InterventionPlan } from "./intervention";

export interface GeneratedReviewCard {
  front: string;
  back: string;
  tags: string[];
  /** 7 天干预窗口到期时间（schedule 动作时取自 plan.checkAt）。 */
  dueAt?: string;
}

export interface GeneratedVariant {
  stem: string;
  answer: string;
  options?: string[];
  hint: string;
}

export interface GeneratedStepGuide {
  steps: string[];
}

export type GeneratedIntervention =
  | { kind: "review-card"; card: GeneratedReviewCard }
  | { kind: "variant"; variant: GeneratedVariant }
  | { kind: "step-guide"; guide: GeneratedStepGuide };

const CAUSE_LABELS: Record<string, string> = {
  concept: "概念理解",
  misread: "读题偏差",
  calculation: "计算错误",
  steps: "步骤遗漏",
  time: "时间不足",
  other: "其他",
};

function letterIndex(answer: string): number {
  const code = answer.trim().toUpperCase().charCodeAt(0);
  return code >= 65 && code <= 90 ? code - 65 : -1;
}

/** 循环左移一位选项，并把答案字母映射到移位后的位置。 */
function shiftOptions(options: string[], answer: string): { options: string[]; answer: string } {
  const n = options.length;
  const shifted = options.map((_, i) => options[(i + 1) % n] as string);
  const idx = letterIndex(answer);
  if (idx < 0 || idx >= n) return { options: shifted, answer };
  const newIdx = (idx - 1 + n) % n;
  return { options: shifted, answer: String.fromCharCode(65 + newIdx) };
}

export function generateVariant(item: PracticeItem): GeneratedVariant {
  if (item.kind === "multiple_choice" && item.options && item.options.length > 0) {
    const { options, answer } = shiftOptions(item.options, item.answer);
    return {
      stem: `（变式）${item.stem}`,
      answer,
      options,
      hint: "选项顺序已调整，请独立判断。",
    };
  }
  return {
    stem: item.stem,
    answer: item.answer,
    options: item.options,
    hint: "请换一种思路重新独立完成本题。",
  };
}

export function generateReviewCard(
  item: PracticeItem,
  cause: string | null,
  dueAt?: string,
): GeneratedReviewCard {
  const tag = cause ? (CAUSE_LABELS[cause] ?? "干预") : "干预";
  return {
    front: item.stem,
    back: `参考答案：${item.answer}`,
    tags: [tag, "干预"],
    ...(dueAt ? { dueAt } : {}),
  };
}

export function generateStepGuide(): GeneratedStepGuide {
  return {
    steps: [
      "圈出题干中的已知条件与所求",
      "回忆与本题相关的定义或公式",
      "按规范步骤逐步求解",
      "代入检验结果是否自洽",
    ],
  };
}

/**
 * 把干预计划落成具体内容（规则候选，无需 AI）：
 * - steps → 步骤提示；calculation → 变式；review/schedule → 复习卡；
 * - schedule 的复习卡带 7 天干预窗口到期时间。
 */
export function generateInterventionContent(
  plan: InterventionPlan,
  item: PracticeItem,
): GeneratedIntervention {
  switch (plan.action) {
    case "variant":
      return { kind: "variant", variant: generateVariant(item) };
    case "schedule":
      return { kind: "review-card", card: generateReviewCard(item, plan.cause, plan.checkAt) };
    default:
      if (plan.cause === "steps") {
        return { kind: "step-guide", guide: generateStepGuide() };
      }
      return { kind: "review-card", card: generateReviewCard(item, plan.cause) };
  }
}
