"use client";

import type { MeasurementActionInput, MeasurementAttempt } from "@aistudy/contracts";
import { useState } from "react";
import { Lightbulb, SkipForward } from "lucide-react";
import { ui } from "../design/ui";
import { measurementPhaseLabels } from "./measurement-model";

export type MeasurementAction = MeasurementActionInput extends infer T ? T extends { clientKey: string } ? Omit<T, "clientKey"> : never : never;

export function MeasurementAttemptCard({ attempt, busy, onAction }: {
  attempt: MeasurementAttempt; busy: boolean; onAction: (action: MeasurementAction) => void;
}) {
  const [answer, setAnswer] = useState("");
  const practice = attempt.item.phase === "practice";
  const hasExternalHelp = attempt.helpEvents.some(event => event.kind === "external");

  return <section className={`${ui.panel} space-y-5 p-5`} aria-labelledby="measurement-question">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
      <span>{measurementPhaseLabels[attempt.item.phase]} · 第 {attempt.ordinal} 题</span>
      <span>{attempt.item.skillLabel}</span>
    </div>
    <h2 id="measurement-question" className="whitespace-pre-wrap text-base font-medium leading-8 text-zinc-900">{attempt.item.prompt}</h2>
    <form onSubmit={event => { event.preventDefault(); if (answer && !busy) onAction({ action: "answer", answer }); }}>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="sr-only">选择你的答案</legend>
        {attempt.item.options.map(option => <label key={option.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 px-3 py-3 text-sm leading-6 text-zinc-700 has-[:checked]:border-emerald-700 has-[:checked]:bg-emerald-50 focus-within:ring-2 focus-within:ring-emerald-600">
          <input type="radio" name={`answer-${attempt.id}`} value={option.id} checked={answer === option.id} onChange={() => setAnswer(option.id)} className="mt-1 size-4 shrink-0 accent-emerald-700" />
          <span>{option.label}</span>
        </label>)}
      </fieldset>
      <div className="mt-5 flex flex-wrap gap-2">
        <button className={ui.primary} disabled={!answer || busy} type="submit">提交答案</button>
        <button className={ui.secondary} disabled={busy} type="button" onClick={() => onAction({ action: "skip" })}><SkipForward size={14} aria-hidden="true" />暂时跳过</button>
      </div>
    </form>
    <div className="space-y-3 border-t border-zinc-100 pt-4">
      {practice ? <div className="flex flex-wrap gap-2">
        <button className={ui.quiet} disabled={busy || attempt.helpEvents.some(event => event.kind === "hint")} type="button" onClick={() => onAction({ action: "help", kind: "hint" })}><Lightbulb size={14} aria-hidden="true" />给我提示</button>
        <button className={ui.quiet} disabled={busy || attempt.helpEvents.some(event => event.kind === "solution")} type="button" onClick={() => onAction({ action: "help", kind: "solution" })}>查看解析</button>
      </div> : <p className="text-xs leading-6 text-zinc-500">这轮请独立完成。3 题均提交或跳过后，再显示本轮结果与解析。</p>}
      <label className="flex items-start gap-2 text-xs leading-6 text-zinc-600">
        <input type="checkbox" className="mt-1 size-4 shrink-0 accent-emerald-700" checked={hasExternalHelp} disabled={busy || hasExternalHelp} onChange={() => onAction({ action: "help", kind: "external" })} />
        我看过相关答案，或使用了教材、搜索、AI、他人帮助
      </label>
      {attempt.helpEvents.length ? <p className="text-xs leading-6 text-amber-800" role="status">已记录使用帮助；本题保留为练习记录，不计入独立作答的预测比较。</p> : null}
      {attempt.feedback ? <div className="whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-sm leading-7 text-zinc-700" role="status">{attempt.feedback}</div> : null}
    </div>
  </section>;
}
