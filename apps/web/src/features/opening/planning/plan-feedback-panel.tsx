"use client";

import { useMemo, useRef, useState } from "react";
import type { PlanFeedbackSummary } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { secondaryButtonClass } from "../design/ui";

export function PlanFeedbackReadout({ summary }: { summary: PlanFeedbackSummary }) {
  const { actions, reasons } = summary;
  return <div className="space-y-2 text-xs leading-6 text-zinc-600">
    <p>手动标记完成 {actions.done} 次 · 跳过 {actions.skipped} 次 · 推迟 {actions.deferred} 次</p>
    <p>取消推迟 {actions.resumed} 次。以上按操作次数统计，同一任务可能有多次操作。</p>
    <p>跳过或推迟原因：已提供 {reasons.supplied}/{reasons.eligible} 次，未填写 {reasons.missing} 次，不愿说明 {reasons.declined} 次。
      {reasons.coverage === null ? "尚无可统计样本。" : `填写率 ${Math.round(reasons.coverage * 100)}%。`}</p>
    {reasons.supplied > 0 ? <p>时间不够 {reasons.counts.time_short} · 太难 {reasons.counts.too_hard} · 太简单 {reasons.counts.too_easy} · 不适合目标 {reasons.counts.not_relevant} · 其他 {reasons.counts.other}</p> : null}
    <p>仅统计本功能上线后的任务操作入口，不含补测自动完成；更早的历史未知。操作次数不能代表学习效果。</p>
    <p className="text-[11px] text-zinc-500">统计区间：{new Date(summary.from).toLocaleString("zh-CN")} 至 {new Date(summary.until).toLocaleString("zh-CN")}（不含结束时刻）</p>
  </div>;
}

/** Explicit read, no polling or model requests; failures never render fabricated zeros. */
export function PlanFeedbackPanel({ api: supplied }: { api?: Pick<OpeningApi, "getPlanFeedbackSummary"> }) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const [summary, setSummary] = useState<PlanFeedbackSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function read() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true); setError(""); setSummary(null);
    try { setSummary(await api.getPlanFeedbackSummary(7)); }
    catch { setError("规划反馈暂时无法读取，请重试。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <details className="border-b border-zinc-200 pb-4">
    <summary className="cursor-pointer py-2 text-sm font-medium text-zinc-900">规划反馈记录</summary>
    <div className="mt-3 space-y-3">
      <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void read()}>{pending ? "正在读取…" : "读取近 7 天记录"}</button>
      {error ? <p role="alert" className="text-xs text-amber-800">{error}</p> : null}
      {summary ? <PlanFeedbackReadout summary={summary} /> : <p className="text-xs text-zinc-500">读取完成、跳过、推迟及可选原因，供复盘安排使用。</p>}
    </div>
  </details>;
}
