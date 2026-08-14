"use client";

import { ArrowLeft, CheckCircle2, CircleHelp, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { InterventionSummary, PracticeResultData } from "./result-summary-model";
import { getAttemptEvidenceLabel, statusWordLabel } from "./result-summary-model";

export function ResultSummary({
  data,
  nextHref,
  onOpenReason,
  intervention,
}: {
  data: PracticeResultData;
  nextHref: string;
  onOpenReason: () => void;
  intervention?: InterventionSummary | null;
}) {
  const { event, status } = data;
  const correct = event.correct;
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-8 sm:px-6 lg:px-8">
    <header className="space-y-3 border-b border-line pb-6"><Link className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><p className="text-xs text-text-dim">练习结果</p><h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">作答结果</h1></header>
    <section className="space-y-5" aria-labelledby="practice-result-heading"><div className="flex items-start gap-3"><span className={`mt-0.5 inline-grid size-9 shrink-0 place-items-center rounded-full ${correct ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>{correct ? <CheckCircle2 aria-hidden="true" size={19} /> : <TriangleAlert aria-hidden="true" size={19} />}</span><div className="min-w-0 space-y-1"><h2 className="text-lg font-semibold text-text" id="practice-result-heading">{correct ? "这次作答可以继续" : "这次作答还需要巩固"}</h2><p className="text-sm text-text-dim">{getAttemptEvidenceLabel(event)}</p></div></div>
      {status ? <div className="grid gap-4 border-y border-line py-5"><div className="flex items-center justify-between gap-4"><span className="text-sm text-text-dim">当前状态</span><span className="inline-flex items-center gap-2 text-sm font-semibold text-text"><CircleHelp aria-hidden="true" className="text-primary" size={16} />{statusWordLabel(status.status)}</span></div><div className="grid gap-2 sm:grid-cols-2">{status.summaryMetrics.slice(0, 2).map((metric) => <p className="flex items-center justify-between gap-4 rounded-md bg-surface px-3 py-2 text-xs" key={metric.key}><span className="text-text-dim">{metric.label}</span><span className="font-semibold text-text">{metric.value}</span></p>)}</div></div> : <p className="border-y border-line py-5 text-sm text-text-dim">状态还在整理中，稍后可从今日计划查看变化。</p>}
      {intervention ? <div className="grid gap-2 rounded-lg bg-surface px-4 py-3" aria-label="干预建议"><p className="text-sm font-semibold text-text">干预建议：{intervention.actionLabel}<span className="ml-2 text-xs font-normal text-text-dim">优先级 {intervention.priorityLabel}</span></p><p className="text-xs text-text-dim">建议在 {intervention.checkAtLabel} 前后复查干预效果。</p></div> : null}
      <div className="flex flex-wrap gap-3"><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={onOpenReason} type="button"><CircleHelp aria-hidden="true" size={16} />为什么</button><Link className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href={nextHref}>继续今日计划</Link></div>
    </section>
  </main>;
}
