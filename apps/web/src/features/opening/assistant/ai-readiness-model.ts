export type AiReadinessChecklistItem = {
  key: string;
  ok: boolean;
  detail: string;
  fixHint: string;
  severity?: "hard" | "soft";
};

/** Soft checklist keys (legacy payloads without severity stay soft). */
export const AI_READINESS_CHECKLIST_SOFT_KEYS = new Set([
  "vision_model",
  "reconciled_unknown",
  "parser_ocr",
]);

/** Deep link to advanced settings daily-budget section (hash already used by settings nav). */
export const BUDGET_CONFIRM_HREF = "/settings/advanced#daily-budget";

/** Lead copy when hard-blocked by budget / no available model (cap/confirm). */
export const BUDGET_CONFIRM_LEAD = "日额度未开启/未确认，辅导暂不可用";

/** Primary CTA label for budget confirm. */
export const BUDGET_CONFIRM_CTA = "去确认每日额度";

/** Soft readiness rows must not keep "AI unavailable" open (vision is photo-only; OCR is scanned-PDF only). */
export function isAiReadinessChecklistHardBlocker(item: AiReadinessChecklistItem): boolean {
  if (item.ok) return false;
  if (item.severity === "soft") return false;
  if (item.severity === "hard") return true;
  // Legacy payloads without severity: soft checklist keys stay soft.
  return !AI_READINESS_CHECKLIST_SOFT_KEYS.has(item.key);
}

export function isAiReadinessChecklistSoftHintRow(item: AiReadinessChecklistItem): boolean {
  if (item.severity === "soft") return true;
  return AI_READINESS_CHECKLIST_SOFT_KEYS.has(item.key);
}

/**
 * Hard fail on daily_budget and/or available_model (cap/confirm gate).
 * Used to surface the budget-confirm CTA when the assistant is hard-blocked.
 */
export function isBudgetRelatedHardBlocker(item: AiReadinessChecklistItem): boolean {
  if (!isAiReadinessChecklistHardBlocker(item)) return false;
  return item.key === "daily_budget" || item.key === "available_model";
}

/** True when checklist is hard-blocked and at least one blocker is budget/available-model. */
export function needsBudgetConfirmCta(items: AiReadinessChecklistItem[]): boolean {
  const hardBlocked = items.some(isAiReadinessChecklistHardBlocker);
  if (!hardBlocked) return false;
  return items.some(isBudgetRelatedHardBlocker);
}
