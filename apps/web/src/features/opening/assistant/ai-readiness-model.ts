export type AiReadinessChecklistItem = {
  key: string;
  ok: boolean;
  detail: string;
  fixHint: string;
  severity?: "hard" | "soft";
  status?: "not_configured" | "missing_files" | "preflight_failed" | "ready" | "unknown";
  checkedAt?: string | null;
};

/** Worker observations only. A configured Web environment is not OCR proof. */
export function parserOcrReadinessItem(report: {
  status: "not_configured" | "missing_files" | "preflight_failed" | "ready";
  checkedAt: string; expiresAt: string; missingFiles: string[];
} | null, now = Date.now()): AiReadinessChecklistItem {
  const status = report && Date.parse(report.expiresAt) > now ? report.status : "unknown";
  const details = {
    not_configured: "解析 Worker 未配置离线 OCR；扫描件可能没有可读文字。",
    missing_files: "解析 Worker 的 OCR 目录或模型文件不完整。",
    preflight_failed: "解析 Worker 的 OCR 小推理检查失败或超时。",
    ready: "解析 Worker 已验证 OCR 目录、四个模型文件与小推理；不代表公式识别准确。",
    unknown: "尚无有效的解析 Worker OCR 实测报告（未上报或已过期）。",
  };
  return { key: "parser_ocr", ok: status === "ready", severity: "soft", status,
    checkedAt: status === "unknown" ? null : report!.checkedAt, detail: details[status],
    fixHint: "由管理员检查解析 Worker 的离线 OCR 模型与健康报告；文字辅导不受此项阻挡。" };
}

/** Soft checklist keys (legacy payloads without severity stay soft). */
export const AI_READINESS_CHECKLIST_SOFT_KEYS = new Set([
  "vision_model",
  "reconciled_unknown",
  "parser_ocr",
]);

/** Deep link to advanced settings daily-budget section (hash already used by settings nav). */
export const BUDGET_CONFIRM_HREF = "/opening/settings/advanced#daily-budget";

/** Lead copy when hard-blocked by budget / no available model (cap/confirm). */
export const BUDGET_CONFIRM_LEAD = "开启 AI 辅导前，先确认每日额度";

/** Primary CTA label for budget confirm. */
export const BUDGET_CONFIRM_CTA = "去开启";

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
