/**
 * Opening AI readiness checklist classification.
 * Hard blockers gate "AI still unavailable" / text tutor readiness.
 * Soft items (e.g. vision) are hints for photo materials and must not block text tutoring.
 */

export type AiReadinessSeverity = "hard" | "soft";

export type AiReadinessItem = {
  key: string;
  ok: boolean;
  detail: string;
  fixHint: string;
  severity: AiReadinessSeverity;
};

/** Soft keys never count as hard blockers for text-tutor readiness. */
export const AI_READINESS_SOFT_KEYS = new Set(["vision_model", "reconciled_unknown"]);

export function aiReadinessSeverityForKey(key: string): AiReadinessSeverity {
  return AI_READINESS_SOFT_KEYS.has(key) ? "soft" : "hard";
}

export function isAiReadinessHardBlocker(
  item: Pick<AiReadinessItem, "key" | "ok"> & { severity?: AiReadinessSeverity },
): boolean {
  if (item.ok) return false;
  const severity = item.severity ?? aiReadinessSeverityForKey(item.key);
  return severity === "hard";
}

export function hasAiReadinessHardBlockers(
  items: Array<Pick<AiReadinessItem, "key" | "ok"> & { severity?: AiReadinessSeverity }>,
): boolean {
  return items.some(isAiReadinessHardBlocker);
}

export type AiReadinessFacts = {
  keyedModelCount: number;
  pricingConfigured: boolean;
  effectiveCapCents: number;
  usedCents: number;
  remainingCents: number;
  reconciledUnknownCount: number;
  visionAvailable: boolean;
  workerOk: boolean;
  workerDetail: string;
  availableModelCount: number;
};

function item(
  key: string,
  ok: boolean,
  detail: string,
  fixHint: string,
): AiReadinessItem {
  return { key, ok, detail, fixHint, severity: aiReadinessSeverityForKey(key) };
}

/**
 * Build readiness checklist items from counted/boolean facts (no secrets).
 * Budget 0 remains a hard fail (`daily_budget` + typically `available_model`).
 * Missing vision is soft only.
 */
export function buildAiReadinessItems(facts: AiReadinessFacts): AiReadinessItem[] {
  return [
    item(
      "provider_key",
      facts.keyedModelCount > 0,
      facts.keyedModelCount > 0 ? `${facts.keyedModelCount} 个模型已配置密钥` : "没有已配置密钥的模型",
      "在高级设置 /settings/advanced → AI 模型与供应商中配置密钥，或联系管理员配置服务器目录。",
    ),
    item(
      "default_pricing",
      facts.pricingConfigured,
      facts.pricingConfigured ? "默认模型定价已配置" : "默认模型定价缺失",
      "在模型目录或自定义供应商中填写正数单价。",
    ),
    item(
      "daily_budget",
      facts.effectiveCapCents > 0,
      facts.effectiveCapCents > 0
        ? `有效日额度 ${facts.effectiveCapCents} 分，今日已用 ${facts.usedCents}，剩余 ${facts.remainingCents}`
        : "日额度未开启（有效额度为 0）",
      "在高级设置 /settings/advanced →「开启并确认每日额度」中设置额度并确认后保存。",
    ),
    item(
      "reconciled_unknown",
      true,
      `近 24 小时对账完成的未知预留 ${facts.reconciledUnknownCount} 笔`,
      "无需处理；超时未知预留会在下次预留时自动对账。",
    ),
    item(
      "vision_model",
      facts.visionAvailable,
      facts.visionAvailable ? "有支持图片的可用模型" : "没有支持图片的可用模型",
      "可选：照片/PDF 图片材料才需要视觉模型；文字辅导不要求。在高级设置 /settings/advanced 中选择 supportsVision 的模型。",
    ),
    item(
      "worker_backlog",
      facts.workerOk,
      facts.workerDetail,
      "检查 worker 进程是否在运行，并查看 opening_jobs / opening_outbox。",
    ),
    item(
      "available_model",
      facts.availableModelCount > 0,
      facts.availableModelCount > 0
        ? `${facts.availableModelCount} 个模型当前可用`
        : "当前没有可用模型",
      "同时满足密钥、定价与日额度 > 0 后，模型才会显示为可用。到高级设置 /settings/advanced 开启并确认每日额度。",
    ),
  ];
}
