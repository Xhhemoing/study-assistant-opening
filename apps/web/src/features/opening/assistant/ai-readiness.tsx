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
          <Link href="/settings/advanced" className="underline underline-offset-2">打开高级设置 · AI 模型与每日额度</Link>
        </p>
      </section>
    );
  }

  return (
    <section
      className={`space-y-2 rounded-lg border border-amber-200 bg-amber-50/80 p-3 ${className}`}
      aria-labelledby="ai-readiness-heading"
      data-ai-readiness="hard-blocked"
      data-budget-confirm={showBudgetCta ? "needed" : "not-needed"}
    >
      {showBudgetCta ? (
        <div
          role="status"
          className="space-y-2 rounded-md border border-amber-300 bg-amber-100/90 px-3 py-2"
          data-testid="ai-readiness-budget-banner"
        >
          <p className="text-sm font-medium text-amber-950">{BUDGET_CONFIRM_LEAD}</p>
          <p className="text-xs leading-5 text-amber-900">
            辅导需要有效日额度（正数）并确认后才会开放。请到高级设置开启并确认每日额度。
          </p>
          <Link
            href={BUDGET_CONFIRM_HREF}
            className="inline-flex min-h-9 items-center justify-center rounded-md bg-emerald-700 px-3 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50"
            data-testid="ai-readiness-budget-cta"
          >
            {BUDGET_CONFIRM_CTA}
          </Link>
        </div>
      ) : null}
      <h3 id="ai-readiness-heading" className="text-sm font-medium text-amber-950">AI 为何还不可用</h3>
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
          <Link href="/settings/advanced" className="underline underline-offset-2">打开高级设置 · AI 模型与每日额度</Link>
          {" "}调整密钥、定价与每日额度。
        </p>
      ) : (
        <p className="text-xs text-amber-900">
          也可从{" "}
          <Link href={BUDGET_CONFIRM_HREF} className="underline underline-offset-2">高级设置 · 每日额度</Link>
          {" "}调整密钥、定价与确认状态。
        </p>
      )}
    </section>
  );
}

export function AiReadinessChecklist({
  className = "",
  showVisionHint = false,
}: {
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

  if (error) return <p role="alert" className={`text-sm text-amber-800 ${className}`}>{error}</p>;
  if (!items) return <p className={`text-sm text-zinc-500 ${className}`} role="status">正在检查 AI 就绪状态…</p>;

  return <AiReadinessChecklistView items={items} className={className} showVisionHint={showVisionHint} />;
}

export { isAiReadinessChecklistHardBlocker };
