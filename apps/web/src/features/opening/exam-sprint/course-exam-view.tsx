"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useRef, useState } from "react";
import { courseExamOverviewSchema, type CourseExamInput, type CourseExamOverview } from "@aistudy/contracts";
import { ui } from "../design/ui";

export function CourseExamView({ initial }: { initial: CourseExamOverview }) {
  const [data, setData] = useState(initial), [sourceId, setSourceId] = useState(initial.sources[0]?.id ?? "");
  const [questionCount, setQuestionCount] = useState(5), [firstPage, setFirstPage] = useState(""), [lastPage, setLastPage] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<CourseExamInput | null>(null);
  const endpoint = `/api/opening/courses/${initial.courseId}/exam`;

  async function readResponse(response: Response) {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? body.message ?? "考前练习暂时无法读取，请重试。");
    const result = courseExamOverviewSchema.parse(body);
    setData(result);
    const current = pending.current && result.papers.find(paper => paper.clientKey === pending.current!.clientKey);
    if (current && current.status !== "pending") pending.current = null;
    return result;
  }
  async function refresh() {
    if (busy) return;
    setBusy(true); setError("");
    try { await readResponse(await fetch(endpoint, { cache: "no-store" })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function generate() {
    if (busy || !sourceId) return;
    setBusy(true); setError("");
    if (!pending.current) pending.current = { clientKey: crypto.randomUUID(), sourceId, questionCount,
      ...(firstPage ? { firstPage: Number(firstPage) } : {}), ...(lastPage ? { lastPage: Number(lastPage) } : {}) };
    try {
      await readResponse(await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pending.current) }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "组卷尚未完成，请刷新查看。"); }
    finally { setBusy(false); }
  }
  const change = () => { pending.current = null; };
  return <main className="mx-auto w-full max-w-[760px] space-y-6 px-4 py-6 sm:px-6">
    <header className="space-y-2">
      <Link className={ui.quiet} href={`/opening/courses/${initial.courseId}`}>返回课程</Link>
      <h1 className="text-title font-semibold tracking-[-0.01em]">{data.courseTitle} · 考前练习</h1>
      <p className="text-sm text-text-2">{data.targetDate ? `考试目标 ${data.targetDate}` : "按课程内容准备考试"}{data.dailyMinutes ? ` · 每天约 ${data.dailyMinutes} 分钟` : ""}</p>
    </header>
    <section className="space-y-4 rounded-xl border border-line bg-surface p-5" aria-label="选择真题并组卷">
      <div className="flex flex-wrap items-center gap-3">
        <Link className={ui.quiet} href={`/opening/library?tab=materials&courseId=${initial.courseId}#upload`}>上传真题到这门课</Link>
        <button type="button" className={ui.quiet} disabled={busy} onClick={refresh}>刷新材料与结果</button>
      </div>
      {data.sources.length ? <>
        <label className="block text-sm">选择真题或样卷<select className={ui.input} value={sourceId} disabled={busy} onChange={event => { setSourceId(event.target.value); change(); }}>
          <option value="">请选择</option>{data.sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select></label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">题量<select className={ui.input} value={questionCount} disabled={busy} onChange={event => { setQuestionCount(Number(event.target.value)); change(); }}>{[3,5,8,10].map(count => <option key={count} value={count}>{count} 题</option>)}</select></label>
          <details className="text-sm" open={Boolean(firstPage || lastPage)}><summary className="min-h-10 cursor-pointer py-2 text-text-2">限定页码</summary><div className="mt-1 flex gap-2">
          <label className="text-sm">起始页<input className={`${ui.input} w-24`} type="number" min={1} value={firstPage} disabled={busy} onChange={event => { setFirstPage(event.target.value); change(); }} /></label>
          <label className="text-sm">结束页<input className={`${ui.input} w-24`} type="number" min={1} value={lastPage} disabled={busy} onChange={event => { setLastPage(event.target.value); change(); }} /></label>
          </div></details>
        </div>
        <button type="button" className={ui.primary} disabled={busy || !sourceId} onClick={generate}>{busy ? "正在准备…" : pending.current ? "查看这次组卷结果" : "分析考点并组卷"}</button>
        {pending.current && !busy ? <button type="button" className={ui.quiet} onClick={() => { pending.current = null; setError("已准备另开一份；再次组卷会重新调用模型。"); }}>另开一份练习</button> : null}
      </> : <p className="text-sm text-text-2">先上传一份真题，等材料读取完成后回到这里组卷。</p>}
      {error ? <p role="alert" className="text-sm text-warn">{error}</p> : null}
    </section>
    <section className="space-y-3" aria-label="已生成的考前练习">
      {data.papers.map(paper => <article key={paper.id} className="space-y-2 rounded-xl border border-line p-4">
        <h2 className="font-semibold">{paper.title ?? paper.sourceTitle}</h2>
        {paper.topics.length ? <p className="text-sm text-text-2">考点：{paper.topics.join("、")}</p> : null}
        <p className="text-sm text-text-2">{paper.questionCount} 题 · {paper.sourceTitle}</p>
        {paper.activityId ? <><Link className={ui.primary} href={`/opening/courses/${initial.courseId}/study?activity=${paper.activityId}`}>开始模拟练习</Link><p className="text-xs text-text-3">AI 根据材料生成的变式题；参考解答可在作答后查看。</p></>
          : <p className="text-sm text-text-2">{!paper.available ? "原材料已变化，请重新选择材料。" : paper.status === "pending" ? "正在生成，请稍后刷新。" : paper.status === "failed" ? "本次组卷未能开始，可以检查模型设置后另开一份。" : "尚未收到完整结果，请刷新查看后再决定是否另开一份。"}</p>}
      </article>)}
    </section>
  </main>;
}
