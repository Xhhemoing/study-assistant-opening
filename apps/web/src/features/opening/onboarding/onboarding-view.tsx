"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { openingOnboardingResultSchema, type OpeningOnboardingInput } from "@aistudy/contracts";
import { createOpeningApi } from "../client/api";
import { UploadStrip } from "../assistant/upload-strip";
import { buttonClass, secondaryButtonClass } from "../design/ui";

export function OpeningOnboardingView() {
  const router = useRouter(), api = useMemo(() => createOpeningApi(), []);
  const [subject, setSubject] = useState(""), [examDate, setExamDate] = useState("");
  const [scenario, setScenario] = useState<"final" | "gaokao" | "kaoyan" | "custom">("custom");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai"), [sourceIds, setSourceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState("");
  const pending = useRef<OpeningOnboardingInput | null>(null);
  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    let active = true;
    void fetch("/api/opening/onboarding", { cache: "no-store" }).then(async response => {
      if (response.status === 401) { router.replace("/login?returnTo=%2Fonboarding"); return; }
      if (!response.ok) throw new Error("无法读取首启状态，请刷新重试。");
      const state = openingOnboardingResultSchema.parse(await response.json());
      if (state.completed) router.replace("/opening/today");
      else if (active) setReady(true);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "无法准备学习空间。"); });
    return () => { active = false; };
  }, [router]);
  async function submit(skip: boolean) {
    if (busy || (!pending.current && !skip && !subject.trim())) return;
    pending.current ??= skip ? { action: "skip", clientKey: `onboarding:${crypto.randomUUID()}` }
      : { action: "complete", clientKey: `onboarding:${crypto.randomUUID()}`, subject, scenario, examDate: examDate || null, timeZone, sourceIds };
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/opening/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pending.current) });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 400 || response.status === 404 || response.status === 422) pending.current = null;
        throw new Error(body.error?.message ?? "首启未完成；请重试同一次提交。");
      }
      const saved = openingOnboardingResultSchema.parse(body);
      router.replace(saved.courseId ? `/opening/assistant?courseId=${saved.courseId}` : "/opening/library");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "网络中断，重试不会重复创建课程与任务。"); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-2xl space-y-6 px-5 py-10">
    <header className="space-y-2"><p className="text-sm font-medium text-emerald-700">开始你的学习闭环</p><h1 className="text-2xl font-semibold text-zinc-900">先确定一个具体的学习起点</h1><p className="text-sm leading-6 text-zinc-600">不需要先配置 AI。保存目标后，可以直接阅读材料、记录笔记，再逐步启用讲解、练习和复习。</p></header>
    {error ? <p role="alert" className="text-sm leading-6 text-red-700">{error}</p> : null}
    {!ready ? <p role="status" className="text-sm text-zinc-600">正在准备学习空间…</p> : <fieldset disabled={busy || Boolean(pending.current)} className="space-y-5">
      <section className="space-y-2"><label className="block text-sm font-medium text-zinc-800" htmlFor="onboarding-subject">1. 你想学什么？</label>
        <input id="onboarding-subject" value={subject} onChange={event => setSubject(event.target.value)} maxLength={160} placeholder="例如：微积分的分部积分" className="w-full rounded border border-zinc-300 p-2 text-sm focus-visible:ring-2 focus-visible:ring-emerald-700" />
        <label className="flex items-center gap-3 text-xs text-zinc-600">学习场景<select value={scenario} onChange={event => setScenario(event.target.value as typeof scenario)} className="rounded border border-zinc-300 bg-white p-2"><option value="custom">日常学习</option><option value="final">期末考试</option><option value="kaoyan">考研</option><option value="gaokao">高考</option></select></label>
      </section>
      <section className="space-y-2"><label htmlFor="onboarding-exam" className="block text-sm font-medium text-zinc-800">2. 什么时候考？暂时没有可以留空。</label><input id="onboarding-exam" type="date" value={examDate} onChange={event => setExamDate(event.target.value)} className="rounded border border-zinc-300 p-2 text-sm" /><p className="text-xs text-zinc-500">只记录考试日期，不猜测具体考试时刻，不擅自修改已有任务截止日期。</p></section>
      <section className="space-y-2"><h2 className="text-sm font-medium text-zinc-800">3. 有没有材料？可以直接上传，也可以稍后添加。</h2><UploadStrip api={api} disabled={busy || Boolean(pending.current)} onUploaded={ids => setSourceIds(current => [...new Set([...current, ...(ids ?? [])])].slice(0, 32))} /><p className="text-xs text-zinc-500">已选择 {sourceIds.length} 份材料。解析未完成时不冒充已读懂材料。</p></section>
      <aside className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><p>保存时会建立课程和三项起步任务：基线试做、概念与例题、独立变式。当前状态为“未测”，不会预设你薄弱或已经掌握。</p><p>初始可用时间暂按每天 20:00–21:00，尚无课表。生成的是待确认草稿，不代表这些时间已经核实；在设置页可调整。</p><label className="flex flex-wrap items-center gap-2">使用时区<input value={timeZone} onChange={event => setTimeZone(event.target.value)} className="rounded border border-amber-300 bg-white px-2 py-1 text-zinc-800" /></label></aside>
    </fieldset>}
    {ready ? <div className="flex flex-wrap gap-3"><button type="button" className={buttonClass} disabled={busy || (!subject.trim() && pending.current?.action !== "skip")} onClick={() => void submit(false)}>{busy ? "正在保存…" : pending.current ? "重试同次提交" : "保存目标与起步任务"}</button><button type="button" className={secondaryButtonClass} disabled={busy || Boolean(pending.current)} onClick={() => void submit(true)}>暂不设目标，从笔记或材料开始</button></div> : null}
    <p className="text-xs text-zinc-500"><Link className="underline" href="/settings#planning">课表与可用时间设置</Link> · <Link className="underline" href="/settings/advanced">稍后配置 AI</Link></p>
  </main>;
}
