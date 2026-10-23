"use client";
import { TransitionLink as Link } from "../opening/v3/motion/view-transition";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { ui } from "../opening/design/ui";
import { FirstLearningMaterials } from "./first-learning-materials";
import { emptyFirstLearningDraft, readFirstLearningDraft, saveFirstLearningDraft, submitFirstLearningDraft, type FirstLearningDraft } from "./first-learning-draft";

export function FirstLearningForm({ draftKey, onStarted }: { draftKey: string; onStarted: (href: string) => void }) {
  const [draft, setDraft] = useState<FirstLearningDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [destination, setDestination] = useState<string | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    let restored: FirstLearningDraft | null = null;
    try { restored = readFirstLearningDraft(window.sessionStorage, draftKey); } catch { /* Storage can be disabled. */ }
    setDraft(restored ?? emptyFirstLearningDraft(crypto.randomUUID(), Intl.DateTimeFormat().resolvedOptions().timeZone));
  }, [draftKey]);
  function persist(next: FirstLearningDraft) {
    try { saveFirstLearningDraft(window.sessionStorage, draftKey, next); } catch { /* Storage can be disabled. */ }
  }
  function update(patch: Partial<FirstLearningDraft>) {
    if (!draft || locked.current) return;
    const next = { ...draft, ...patch, clientKey: crypto.randomUUID() };
    setDraft(next); persist(next); setError("");
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || locked.current) return;
    locked.current = true; setBusy(true); setError(""); persist(draft);
    try {
      const result = await submitFirstLearningDraft(draft);
      setDestination(result.href);
      // Keep the confirmed intent until the next page opens; even a stalled navigation can safely resume it.
      onStarted(result.href);
    } catch (cause) {
      setError(cause instanceof z.ZodError ? "请检查主题、目标日期和每日学习时间。" : cause instanceof Error ? cause.message : "暂时无法开始，请保留内容后重试。");
      locked.current = false; setBusy(false);
    }
  }
  if (!draft) return <p className="text-sm text-zinc-500" role="status">正在准备学习意图…</p>;
  return <form className="space-y-4" onSubmit={submit} aria-busy={busy} aria-label="首次学习设置">
    <div className="space-y-1.5"><label className={ui.label} htmlFor="first-topic">想学什么？</label>
      <input id="first-topic" className={ui.input} required maxLength={120} disabled={busy} placeholder="例如：矩阵为什么能表示线性变换" value={draft.topic} onChange={event => update({ topic: event.target.value })} /></div>
    <div className="space-y-1.5"><label className={ui.label} htmlFor="first-goal">学完希望做到什么？（可选）</label>
      <textarea id="first-goal" className={`${ui.input} min-h-20 leading-6`} maxLength={1000} disabled={busy} placeholder="例如：能用二维图形解释矩阵乘法" value={draft.goal} onChange={event => update({ goal: event.target.value })} /></div>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div className="space-y-1.5"><label className={ui.label} htmlFor="first-date">目标日期（可选）</label><input id="first-date" className={ui.input} type="date" disabled={busy} value={draft.targetDate} onChange={event => update({ targetDate: event.target.value })} /></div>
      <div className="space-y-1.5"><label className={ui.label} htmlFor="first-minutes">每天几分钟？</label><input id="first-minutes" className={ui.input} type="number" required min={10} max={180} step={1} disabled={busy} value={draft.minutes || ""} onChange={event => update({ minutes: Number(event.target.value) })} /></div>
      <div className="space-y-1.5"><label className={ui.label} htmlFor="first-time">通常几点开始？</label><input id="first-time" className={ui.input} type="time" required disabled={busy} value={draft.startTime} onChange={event => update({ startTime: event.target.value })} /></div>
    </div>
    <p className="text-xs leading-6 text-zinc-500">按 {draft.timeZone} 记录。已有学习时间设置会保留；新计划需由你确认。</p>
    <FirstLearningMaterials selected={draft.sourceIds} disabled={busy} onChange={sourceIds => update({ sourceIds })} />
    {error ? <div className="space-y-2 text-sm leading-6 text-red-700" role="alert"><p>{error}</p><Link className={ui.quiet} href="/opening/today">查看今日页</Link><Link className={ui.quiet} href="/opening/settings">检查学习设置</Link></div> : null}
    {destination ? <p className="text-sm text-zinc-600" role="status">正在进入第一节课。<a className={ui.quiet} href={destination}>继续进入</a></p> : null}
    <button className={`${ui.primary} w-full sm:w-auto`} disabled={busy} type="submit">{busy ? <LoaderCircle className="motion-safe:animate-spin" size={16} aria-hidden /> : <ArrowRight size={16} aria-hidden />}{busy ? "正在准备…" : "保存目标并开始"}</button>
    <p className="text-xs leading-6 text-zinc-500">按当前配置准备主讲内容。AI 不可用时仍保留目标与任务，可以继续向助理提问或记笔记。</p>
  </form>;
}
