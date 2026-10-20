"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  BUDGET_CONFIRM_CTA,
  BUDGET_CONFIRM_HREF,
  BUDGET_CONFIRM_LEAD,
  isAiReadinessChecklistHardBlocker,
  isAiReadinessChecklistSoftHintRow,
  needsBudgetConfirmCta,
  type AiReadinessChecklistItem,
} from "./ai-readiness-model";

type ReadinessItem = AiReadinessChecklistItem;

const LABELS: Record<string, string> = {
  provider_key: "模型密钥",
  default_pricing: "模型定价",
  daily_budget: "每日额度",
  reconciled_unknown: "未知预留对账",
  vision_model: "提示（照片材料才需要，不挡文字辅导）",
  parser_ocr: "提示（扫描件 OCR，不挡文字辅导）",
  worker_backlog: "Worker 积压",
  available_model: "可用模型",
};

function labelForItem(item: ReadinessItem): string {
  if (item.key === "vision_model") return LABELS.vision_model ?? item.key;
  return LABELS[item.key] ?? item.key;
}

/**
 * Presentational readiness panel (items already loaded).
 * Exported for unit tests via renderToStaticMarkup.
 */
export function AiReadinessChecklistView({
  items,
  className = "",
  showVisionHint = false,
}: {
  items: ReadinessItem[];
  className?: string;
  showVisionHint?: boolean;
}) {
  const hardBlocked = items.some(isAiReadinessChecklistHardBlocker);
  const showBudgetCta = needsBudgetConfirmCta(items);
  const visionFail = items.find(item => item.key === "vision_model" && !item.ok);
  const displayItems = showVisionHint
    ? items.filter(item => !isAiReadinessChecklistSoftHintRow(item) || item.key === "vision_model")
    : items.filter(item => !isAiReadinessChecklistSoftHintRow(item));

  if (!hardBlocked) {
    if (!showVisionHint || !visionFail) return null;
    return (
      <section className={`space-y-1 rounded-lg border border-zinc-200 bg-zinc-50/80 p-3 ${className}`} aria-labelledby="ai-readiness-soft-heading">
        <h3 id="ai-readiness-soft-heading" className="text-sm font-medium text-zinc-800">提示（不挡文字辅导）</h3>
        <p className="text-xs leading-6 text-zinc-600">照片/PDF 图片材料需要视觉模型；文字辅导仍可用。</p>
        <p className="text-xs text-zinc-700">
          <Link href="/opening/settings/advanced" className="underline underline-offset-2">打开高级设置 · AI 模型与每日额度</Link>
        </p>
      </section>
    );
  }

  return (
    <section
      className={`shrink-0 border-l-2 border-amber-300 bg-amber-50/50 px-3 py-1 ${className}`}
      aria-labelledby="ai-readiness-heading"
      data-ai-readiness="hard-blocked"
      data-budget-confirm={showBudgetCta ? "needed" : "not-needed"}
    >
      <div className="flex items-start justify-between gap-2" role="status" data-testid={showBudgetCta ? "ai-readiness-budget-banner" : undefined}>
      <details className="min-w-0 flex-1"><summary className="min-h-9 cursor-pointer rounded py-2 text-xs font-medium text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"><span id="ai-readiness-heading">{showBudgetCta ? BUDGET_CONFIRM_LEAD : "AI 辅导暂不可用"}</span><span className="ml-2 font-normal">查看原因</span></summary>
      <div className="max-h-32 overflow-y-auto overscroll-contain pb-2">
      <ul className="space-y-2 text-xs leading-6 text-amber-950">
        {displayItems.map(item => (
          <li key={item.key} className="flex flex-col gap-0.5">
            <span>{item.ok ? "✓" : "✗"} {labelForItem(item)}：{item.detail}</span>
            {!item.ok ? <span className="text-amber-800/90">去哪里修：{item.fixHint}</span> : null}
          </li>
        ))}
      </ul>
      {!showBudgetCta ? (
        <p className="text-xs text-amber-900">
          <Link href="/opening/settings/advanced" className="underline underline-offset-2">打开高级设置 · AI 模型与每日额度</Link>
          {" "}调整密钥、定价与每日额度。
        </p>
      ) : (
        <p className="text-xs text-amber-900">
          也可从{" "}
          <Link href={BUDGET_CONFIRM_HREF} className="underline underline-offset-2">高级设置 · 每日额度</Link>
          {" "}调整密钥、定价与确认状态。
        </p>
      )}
      </div></details>
      <Link href={showBudgetCta ? BUDGET_CONFIRM_HREF : "/opening/settings/advanced"} className="inline-flex min-h-9 shrink-0 items-center text-xs text-emerald-900 underline underline-offset-2" data-testid={showBudgetCta ? "ai-readiness-budget-cta" : undefined}>{showBudgetCta ? BUDGET_CONFIRM_CTA : "去设置"}</Link>
      </div>
    </section>
  );
}

export function AiReadinessChecklist({
  className = "",
  showVisionHint = false,
  onBlockedChange,
}: {
  onBlockedChange?: (blocked: boolean) => void;
  className?: string;
  /** When true, soft vision tip may render. Default false so assistant readiness stays quiet. */
  showVisionHint?: boolean;
}) {
  const [items, setItems] = useState<ReadinessItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/opening/ai-readiness", { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "就绪清单暂时无法读取");
        if (!controller.signal.aborted) setItems(Array.isArray(body.items) ? body.items : []);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "就绪清单暂时无法读取");
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => { onBlockedChange?.(Boolean(error) || items === null || items.some(isAiReadinessChecklistHardBlocker)); }, [error, items, onBlockedChange]);

  if (error) return <p role="alert" className={`text-sm text-amber-800 ${className}`}>{error}</p>;
  if (!items) return <p className={`text-sm text-zinc-500 ${className}`} role="status">正在检查 AI 就绪状态…</p>;

  return <AiReadinessChecklistView items={items} className={className} showVisionHint={showVisionHint} />;
}

export { isAiReadinessChecklistHardBlocker };
