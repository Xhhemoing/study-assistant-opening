"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type ReadinessItem = {
  key: string;
  ok: boolean;
  detail: string;
  fixHint: string;
  severity?: "hard" | "soft";
};

const LABELS: Record<string, string> = {
  provider_key: "模型密钥",
  default_pricing: "模型定价",
  daily_budget: "每日额度",
  reconciled_unknown: "未知预留对账",
  vision_model: "提示（照片材料才需要，不挡文字辅导）",
  worker_backlog: "Worker 积压",
  available_model: "可用模型",
};

/** Soft readiness rows must not keep "AI unavailable" open (vision is photo-only). */
function isHardBlocker(item: ReadinessItem): boolean {
  if (item.ok) return false;
  if (item.severity === "soft") return false;
  if (item.severity === "hard") return true;
  // Legacy payloads without severity: vision + reconcile stay soft.
  return item.key !== "vision_model" && item.key !== "reconciled_unknown";
}

function labelForItem(item: ReadinessItem): string {
  if (item.key === "vision_model") return LABELS.vision_model ?? item.key;
  return LABELS[item.key] ?? item.key;
}

function isSoftVisionRow(item: ReadinessItem): boolean {
  return item.key === "vision_model";
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

  const hardBlocked = items.some(isHardBlocker);
  const visionFail = items.find(item => item.key === "vision_model" && !item.ok);
  const displayItems = showVisionHint ? items : items.filter(item => !isSoftVisionRow(item));

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
    <section className={`space-y-2 rounded-lg border border-amber-200 bg-amber-50/80 p-3 ${className}`} aria-labelledby="ai-readiness-heading">
      <h3 id="ai-readiness-heading" className="text-sm font-medium text-amber-950">AI 为何还不可用</h3>
      <ul className="space-y-2 text-xs leading-6 text-amber-950">
        {displayItems.map(item => (
          <li key={item.key} className="flex flex-col gap-0.5">
            <span>{item.ok ? "✓" : "✗"} {labelForItem(item)}：{item.detail}</span>
            {!item.ok ? <span className="text-amber-800/90">去哪里修：{item.fixHint}</span> : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-amber-900">
        <Link href="/settings/advanced" className="underline underline-offset-2">打开高级设置 · AI 模型与每日额度</Link>
        {" "}调整密钥、定价与每日额度。
      </p>
    </section>
  );
}

export { isHardBlocker as isAiReadinessChecklistHardBlocker };
