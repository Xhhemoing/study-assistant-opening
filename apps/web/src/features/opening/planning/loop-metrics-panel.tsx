"use client";

import { useRef, useState } from "react";
import type { LoopMetric, LoopMetricsReport } from "@aistudy/contracts";
import { secondaryButtonClass } from "../design/ui";

function metricValue(metric: LoopMetric): string {
  if (metric.dataStatus === "not_collected") return "尚未采集";
  if (metric.dataStatus === "unknown") return "暂无法完整核实";
  if (metric.dataStatus === "no_samples" || metric.value === null) return "尚无样本";
  if (metric.unit === "ratio") return `${Math.round(metric.value * 100)}%`;
  if (metric.unit === "cents") return `${metric.value} 分`;
  if (metric.unit === "minutes") return `${Math.round(metric.value * 10) / 10} 分钟`;
  return `${metric.value} 次`;
}

export function LoopMetricsReadout({ report }: { report: LoopMetricsReport }) {
  const groups = [["runtime", "运行可靠性"], ["learning", "学习结果"], ["burden", "负担与控制"]] as const;
  return <div className="space-y-4 text-xs leading-6 text-zinc-600">
    <p>近 {report.windowDays} 天 · {report.timeZone} · 截至 {new Date(report.asOf).toLocaleString("zh-CN", { timeZone: report.timeZone })}</p>
    {groups.map(([key, title]) => <section key={key} className="space-y-2">
      <h3 className="font-medium text-zinc-900">{title}</h3>
      {report.groups[key].map(metric => <details key={metric.id} className="rounded border border-zinc-200 px-3 py-1">
        <summary className="cursor-pointer">{metric.label}：{metricValue(metric)}</summary>
        <p>样本 {metric.sampleSize}{metric.numerator !== null && metric.denominator !== null ? ` · 分子/分母 ${metric.numerator}/${metric.denominator}` : ""}。{metric.denominatorLabel}</p>
        {Object.entries(metric.excludedReasonCounts).filter(([, n]) => n > 0).map(([reason, n]) => <p key={reason}>{reason}：{n}</p>)}
      </details>)}
    </section>)}
    <details><summary className="cursor-pointer font-medium">口径与限制</summary>
      {report.notes.map(note => <p key={note}>{note}</p>)}
      <p>区间 [{report.windowStart}, {report.windowEnd}) · {report.metricVersion}</p>
    </details>
  </div>;
}

/** The parent supplies the existing authenticated API client; only explicit reads, no polling. */
export function LoopMetricsPanel({ api }: { api: { getLoopMetrics(days?: number): Promise<LoopMetricsReport> } }) {
  const [report, setReport] = useState<LoopMetricsReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function read() {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError(""); setReport(null);
    try { setReport(await api.getLoopMetrics(14)); }
    catch { setError("闭环诊断暂时无法读取，请重试。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <details className="border-b border-zinc-200 pb-4">
    <summary className="cursor-pointer py-2 text-sm font-medium text-zinc-900">学习闭环诊断</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-zinc-500">分别查看运行、学习证据与安排负担；不计算总体分数。</p>
      <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void read()}>{pending ? "正在读取…" : "读取近 14 天诊断"}</button>
      {error ? <p role="alert" className="text-xs text-amber-800">{error}</p> : null}
      {report ? <LoopMetricsReadout report={report} /> : null}
    </div>
  </details>;
}
