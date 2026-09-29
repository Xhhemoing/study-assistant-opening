"use client";

import { PageHeading, ui } from "../opening/design/ui";
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
  return <main className="min-w-0 bg-white"><PageHeading title="作答结果" action={<Link className={ui.quiet} href="/learn"><ArrowLeft aria-hidden="true" size={14} />返回学习空间</Link>} /><div className="mx-auto max-w-3xl px-5 py-5">
    <section className="space-y-5" aria-labelledby="practice-result-heading"><div className="flex items-start gap-3"><span className={`mt-0.5 inline-grid size-10 md:size-8 shrink-0 place-items-center rounded-full ${correct ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{correct ? <CheckCircle2 aria-hidden="true" size={19} /> : <TriangleAlert aria-hidden="true" size={19} />}</span><div className="min-w-0 space-y-1"><h2 className="text-lg font-semibold text-zinc-900" id="practice-result-heading">{correct ? "这次作答可以继续" : "这次作答还需要巩固"}</h2><p className="text-sm text-zinc-500">{getAttemptEvidenceLabel(event)}</p></div></div>
      {status ? <div className="grid gap-4 border-y border-zinc-200 py-5"><div className="flex items-center justify-between gap-4"><span className="text-sm text-zinc-500">当前状态</span><span className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-900"><CircleHelp aria-hidden="true" className="text-emerald-700" size={16} />{statusWordLabel(status.status)}</span></div><div className="grid gap-2 sm:grid-cols-2">{status.summaryMetrics.slice(0, 2).map((metric) => <p className="flex items-center justify-between gap-4 rounded-md bg-white px-3 py-2 text-xs" key={metric.key}><span className="text-zinc-500">{metric.label}</span><span className="font-semibold text-zinc-900">{metric.value}</span></p>)}</div></div> : <p className="border-y border-zinc-200 py-5 text-sm text-zinc-500">状态还在整理中，稍后可从今日计划查看变化。</p>}
      {intervention ? <div className="grid gap-2 rounded-lg bg-white px-4 py-3" aria-label="干预建议"><p className="text-sm font-semibold text-zinc-900">干预建议：{intervention.actionLabel}<span className="ml-2 text-xs font-normal text-zinc-500">优先级 {intervention.priorityLabel}</span></p><p className="text-xs text-zinc-500">建议在 {intervention.checkAtLabel} 前后复查干预效果。</p></div> : null}
      <div className="flex flex-wrap gap-3"><button className={ui.secondary} onClick={onOpenReason} type="button"><CircleHelp aria-hidden="true" size={16} />为什么</button><Link className={ui.primary} href={nextHref}>继续今日计划</Link></div>
    </section>
  </div></main>;
}
