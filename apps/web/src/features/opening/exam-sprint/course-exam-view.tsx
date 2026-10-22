"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { courseExamOverviewSchema, type CourseExamInput, type CourseExamOverview } from "@aistudy/contracts";
import { useConversationObjectHref } from "../assistant/conversation-object-context";
import { ContentBlock, ContentGrid, PageHeader, ui } from "../design/ui";
import { createCourseExamCheckpointStore } from "./course-exam-checkpoint";

export function CourseExamView({ initial }: { initial: CourseExamOverview }) {
  const objectHref = useConversationObjectHref();
  const [data, setData] = useState(initial), [sourceId, setSourceId] = useState(initial.sources[0]?.id ?? "");
  const [questionCount, setQuestionCount] = useState(5), [firstPage, setFirstPage] = useState(""), [lastPage, setLastPage] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [recovering, setRecovering] = useState(true), [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [store] = useState(() => createCourseExamCheckpointStore(initial.courseId));
  const pending = useRef<CourseExamInput | null>(null);
  const flight = useRef(false);
  const mounted = useRef(true);
  const endpoint = `/api/opening/courses/${initial.courseId}/exam`;

  async function readResponse(response: Response) {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? body.message ?? "考前练习暂时无法读取，请重试。");
    const result = courseExamOverviewSchema.parse(body);
    if (!mounted.current) return result;
    setData(result);
    const current = pending.current && result.papers.find(paper => paper.clientKey === pending.current!.clientKey);
    if (current && (current.status === "ready" || current.status === "failed")) { store.clear(); pending.current = null; }
    return result;
  }
  useEffect(() => {
    mounted.current = true;
    async function restore() {
      try {
        const saved = store.read();
        if (!mounted.current || !saved) return;
        pending.current = saved;
        setSourceId(saved.sourceId); setQuestionCount(saved.questionCount);
        setFirstPage(saved.firstPage?.toString() ?? ""); setLastPage(saved.lastPage?.toString() ?? "");
        try { await readResponse(await fetch(endpoint, { cache: "no-store" })); }
        catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "原组卷结果尚未核实，请重试读取。"); }
      } catch (reason) {
        if (mounted.current) { setRecoveryBlocked(true); setError(reason instanceof Error ? reason.message : "原请求恢复失败。"); }
      } finally { if (mounted.current) setRecovering(false); }
    }
    void restore();
    return () => { mounted.current = false; };
    // This course route owns the instance; query-only navigation must keep it mounted.
  }, [store, endpoint]);
  async function refresh() {
    if (flight.current || recovering) return;
    flight.current = true;
    setBusy(true); setError("");
    try { await readResponse(await fetch(endpoint, { cache: "no-store" })); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "读取失败，请重试。"); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  async function generate() {
    if (flight.current || recovering || recoveryBlocked || !sourceId) return;
    flight.current = true;
    setBusy(true); setError("");
    try {
      const input = pending.current ?? { clientKey: crypto.randomUUID(), sourceId, questionCount,
        ...(firstPage ? { firstPage: Number(firstPage) } : {}), ...(lastPage ? { lastPage: Number(lastPage) } : {}) };
      store.write(input); pending.current = input;
      await readResponse(await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pending.current) }));
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "组卷尚未完成，请刷新查看。"); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  function startAnother() {
    try { store.clear(); pending.current = null; setRecoveryBlocked(false); setError("已准备另开一份；再次组卷会重新调用模型。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "尚未另开一份。"); }
  }
  const locked = busy || recovering || recoveryBlocked || Boolean(pending.current);
  return <main className="w-full min-w-0">
    <PageHeader title={`${data.courseTitle} · 考前练习`} action={<Link className={ui.quiet} href={objectHref(`/opening/courses/${initial.courseId}`)}>返回课程</Link>} />
    <ContentGrid className="px-4 py-6 sm:px-8">
    <ContentBlock width="wide">
    <section className="space-y-4 rounded-xl border border-line bg-surface p-5" aria-label="选择真题并组卷">
      {data.targetDate || data.dailyMinutes ? <p className="text-sm text-text-2">{[data.targetDate ? `考试目标 ${data.targetDate}` : null, data.dailyMinutes ? `每天约 ${data.dailyMinutes} 分钟` : null].filter(Boolean).join(" · ")}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Link className={ui.quiet} href={objectHref(`/opening/library?tab=materials&courseId=${initial.courseId}#upload`)}>上传真题到这门课</Link>
        <button type="button" className={ui.quiet} disabled={busy || recovering} onClick={refresh}>刷新材料与结果</button>
      </div>
      {data.sources.length ? <>
        <label className="block text-sm">选择真题或样卷<select className={ui.input} value={sourceId} disabled={locked} onChange={event => { setSourceId(event.target.value); }}>
          <option value="">请选择</option>{data.sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select></label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">题量<select className={ui.input} value={questionCount} disabled={locked} onChange={event => { setQuestionCount(Number(event.target.value)); }}>{[3,5,8,10].map(count => <option key={count} value={count}>{count} 题</option>)}</select></label>
          <label className="text-sm">起始页（可选）<input className={ui.input} type="number" min={1} value={firstPage} disabled={locked} onChange={event => { setFirstPage(event.target.value); }} /></label>
          <label className="text-sm">结束页（可选）<input className={ui.input} type="number" min={1} value={lastPage} disabled={locked} onChange={event => { setLastPage(event.target.value); }} /></label>
        </div>
        <button type="button" className={ui.primary} disabled={busy || recovering || recoveryBlocked || !sourceId} onClick={generate}>{recovering ? "正在核对原组卷…" : busy ? "正在准备…" : pending.current ? "查看这次组卷结果" : "分析考点并组卷"}</button>
      </> : <p className="text-sm text-text-2">先上传一份真题，等材料读取完成后回到这里组卷。</p>}
      {pending.current && !recovering ? <p role="status" className="text-sm text-text-2">原组卷请求已保留。请先刷新核对结果；修改组卷条件前，需要显式另开一份。</p> : null}
      {(pending.current || recoveryBlocked) && !busy && !recovering ? <button type="button" className={ui.quiet} onClick={startAnother}>另开一份练习</button> : null}
      {error ? <p role="alert" className="text-sm text-warn">{error}</p> : null}
    </section>
    </ContentBlock>
    <ContentBlock width="wide">
    <section className="space-y-3" aria-label="已生成的考前练习">
      {data.papers.map(paper => <article key={paper.id} className="space-y-2 rounded-xl border border-line p-4">
        <h2 className="font-semibold">{paper.title ?? paper.sourceTitle}</h2>
        {paper.topics.length ? <p className="text-sm text-text-2">考点：{paper.topics.join("、")}</p> : null}
        <p className="text-sm text-text-2">{paper.questionCount} 题 · {paper.sourceTitle}</p>
        {paper.activityId ? <><Link className={ui.primary} href={objectHref(`/opening/courses/${initial.courseId}/study?activity=${paper.activityId}`)}>开始模拟练习</Link><p className="text-xs text-text-3">AI 根据材料生成的变式题；参考解答可在作答后查看。</p></>
          : <p className="text-sm text-text-2">{!paper.available ? "原材料已变化，请重新选择材料。" : paper.status === "pending" ? "正在生成，请稍后刷新。" : paper.status === "failed" ? "本次组卷未能开始，可以检查模型设置后另开一份。" : "尚未收到完整结果，请刷新查看后再决定是否另开一份。"}</p>}
      </article>)}
    </section>
    </ContentBlock>
    </ContentGrid>
  </main>;
}
