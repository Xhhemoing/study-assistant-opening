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
  if (metric.unit === "milliseconds") return `${(metric.value / 1000).toFixed(2)} 秒`;
  if (metric.unit === "minutes") return `${Math.round(metric.value * 10) / 10} 分钟`;
  return `${metric.value} 次`;
}

export function LoopMetricsReadout({ report }: { report: LoopMetricsReport }) {
  const groups = [["runtime", "运行可靠性"], ["learning", "学习结果"], ["burden", "负担与控制"]] as const;
  const weeklyIds = ["learning.automatic_grading_coverage", "experience.first_text", "experience.next_step_started"];
  const all = Object.values(report.groups).flat();
  return <div className="space-y-4 text-xs leading-6 text-text-2">
    <p>近 {report.windowDays} 天 · {report.timeZone} · 截至 {new Date(report.asOf).toLocaleString("zh-CN", { timeZone: report.timeZone })}</p>
    <section aria-label="本周三项指标" className="grid gap-3 sm:grid-cols-3">{weeklyIds.map(id => {
      const metric = all.find(item => item.id === id);
      return metric ? <div key={id} className="rounded border border-line p-3"><p>{metric.label}</p>
        <p className="text-lg font-semibold text-text">{metricValue(metric)}</p><p>样本 {metric.sampleSize}</p>
        <p className="text-text-3">{metric.denominatorLabel}</p></div> : null;
    })}</section>
    <details><summary className="min-h-11 cursor-pointer py-2">更多诊断</summary>
    {groups.map(([key, title]) => <section key={key} className="space-y-2">
      <h3 className="font-medium text-text">{title}</h3>
      {report.groups[key].filter(metric => !weeklyIds.includes(metric.id)).map(metric => <details key={metric.id} className="rounded border border-line px-3 py-1">
        <summary className="min-h-11 cursor-pointer py-2">{metric.label}：{metricValue(metric)}</summary>
        <p>样本 {metric.sampleSize}{metric.numerator !== null && metric.denominator !== null ? ` · 分子/分母 ${metric.numerator}/${metric.denominator}` : ""}。{metric.denominatorLabel}</p>
        {Object.entries(metric.excludedReasonCounts).filter(([, n]) => n > 0).map(([reason, n]) => <p key={reason}>{reason}：{n}</p>)}
      </details>)}
    </section>)}
    </details>
    <details><summary className="min-h-11 cursor-pointer font-medium py-2">口径与限制</summary>
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
    try { setReport(await api.getLoopMetrics(7)); }
    catch { setError("闭环诊断暂时无法读取，请重试。"); }
    finally { inFlight.current = false; setPending(false); }
  }
  return <details className="border-b border-line pb-4">
    <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-text">学习闭环诊断</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-text-3">每周查看自动判分、回答等待和下一步点击开始情况。</p>
      <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void read()}>{pending ? "正在读取…" : "读取近 7 天指标"}</button>
      {error ? <p role="alert" className="text-xs text-warn">{error}</p> : null}
      {report ? <LoopMetricsReadout report={report} /> : null}
    </div>
  </details>;
}
