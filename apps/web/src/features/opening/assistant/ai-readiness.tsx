"use client";

import { openingAiReadinessResponseSchema, type OpeningAiReadinessResponse } from "@aistudy/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ui } from "../design/ui";

const FIX_HREF: Record<string, string> = {
  provider_key: "/opening/settings",
  default_pricing: "/opening/settings",
  daily_budget: "/opening/settings",
  unknown_reconcile_24h: "/opening/settings",
  vision_model: "/opening/settings",
  worker_backlog: "/opening/settings",
};

export function AiReadinessChecklist({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<OpeningAiReadinessResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/opening/ai-readiness", { cache: "no-store", signal });
      const body = await response.json();
      if (response.status === 401) throw new Error("请先登录后再查看 AI 就绪清单。");
      if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "就绪清单加载失败。");
      if (!signal?.aborted) setData(openingAiReadinessResponseSchema.parse(body));
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : "就绪清单加载失败。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const failed = data?.items.filter(item => !item.ok) ?? [];
  if (loading && !data) {
    return <p className="text-sm text-zinc-500" role="status">正在检查 AI 就绪项…</p>;
  }
  if (error) {
    return <p role="alert" className="text-sm leading-6 text-red-700">{error}</p>;
  }
  if (!data) return null;
  if (compact && failed.length === 0) return null;

  return (
    <section className={compact ? "space-y-2 rounded border border-amber-200 bg-amber-50 px-3 py-2" : "space-y-3"} aria-label="AI 就绪清单">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-900">{failed.length ? "AI 尚未就绪" : "AI 已就绪"}</h3>
        <button type="button" className={ui.quiet} onClick={() => void load()}>刷新</button>
      </div>
      <ul className="space-y-2 text-xs leading-6 text-zinc-700">
        {(compact ? failed : data.items).map(item => (
          <li key={item.key} className="flex flex-wrap items-start justify-between gap-2">
            <span>
              <span className={item.ok ? "text-emerald-700" : "text-amber-900"}>{item.ok ? "✓" : "!"}</span>
              {" "}
              <span className="font-medium">{item.key}</span>
              {" — "}
              {item.detail}
            </span>
            {!item.ok ? (
              <Link className="shrink-0 text-emerald-800 underline" href={FIX_HREF[item.key] ?? "/opening/settings"}>
                去处理
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
