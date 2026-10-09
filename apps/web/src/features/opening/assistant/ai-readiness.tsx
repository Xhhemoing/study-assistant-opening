"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type ReadinessItem = { key: string; ok: boolean; detail: string; fixHint: string };

const LABELS: Record<string, string> = {
  provider_key: "模型密钥",
  default_pricing: "模型定价",
  daily_budget: "每日额度",
  reconciled_unknown: "未知预留对账",
  vision_model: "图片模型",
  worker_backlog: "Worker 积压",
  available_model: "可用模型",
};

export function AiReadinessChecklist({ className = "" }: { className?: string }) {
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

  const blocked = items.filter(item => !item.ok && item.key !== "reconciled_unknown");
  if (!blocked.length && items.every(item => item.ok || item.key === "reconciled_unknown")) {
    return null;
  }

  return (
    <section className={`space-y-2 rounded-lg border border-amber-200 bg-amber-50/80 p-3 ${className}`} aria-labelledby="ai-readiness-heading">
      <h3 id="ai-readiness-heading" className="text-sm font-medium text-amber-950">AI 为何还不可用</h3>
      <ul className="space-y-2 text-xs leading-6 text-amber-950">
        {items.map(item => (
          <li key={item.key} className="flex flex-col gap-0.5">
            <span>{item.ok ? "✓" : "✗"} {LABELS[item.key] ?? item.key}：{item.detail}</span>
            {!item.ok ? <span className="text-amber-800/90">去哪里修：{item.fixHint}</span> : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-amber-900">
        <Link href="/settings" className="underline underline-offset-2">打开设置</Link>
        {" "}调整密钥、定价与每日额度。
      </p>
    </section>
  );
}
