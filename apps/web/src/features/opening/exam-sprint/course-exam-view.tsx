"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useEffect, useRef, useState } from "react";
import { courseExamInputSchema, courseExamOverviewSchema, type CourseExamInput, type CourseExamOverview } from "@aistudy/contracts";
import { useConversationObjectHref } from "../assistant/conversation-object-context";
import { ContentBlock, ContentGrid, PageHeader, ui } from "../design/ui";
import { createCourseExamCheckpointStore } from "./course-exam-checkpoint";
import { userFacingMessage } from "../../../lib/user-facing-error";

class CourseExamHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
  }
}

function sourceAvailable(sources: CourseExamOverview["sources"], id: string) {
  return sources.some(source => source.id === id);
}

function validateCourseExamInput(raw: {
  sourceId: string;
  questionCount: number;
  firstPage: string;
  lastPage: string;
}): { ok: true; input: CourseExamInput } | { ok: false; message: string } {
  const firstTrimmed = raw.firstPage.trim();
  const lastTrimmed = raw.lastPage.trim();
  const firstPage = firstTrimmed === "" ? undefined : Number(firstTrimmed);
  const lastPage = lastTrimmed === "" ? undefined : Number(lastTrimmed);
  const candidate = {
    clientKey: crypto.randomUUID(),
    sourceId: raw.sourceId,
    questionCount: raw.questionCount,
    ...(firstPage !== undefined ? { firstPage } : {}),
    ...(lastPage !== undefined ? { lastPage } : {}),
  };
  const parsed = courseExamInputSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data };
  const issuePaths = new Set(parsed.error.issues.map(issue => issue.path[0]));
  if (issuePaths.has("sourceId")) return { ok: false, message: "请先选择有效的真题或样卷。" };
  if (issuePaths.has("questionCount")) return { ok: false, message: "请选择题量（3 到 10 题）。" };
  if (issuePaths.has("firstPage")) return { ok: false, message: "起始页必须是大于 0 的整数。" };
  if (issuePaths.has("lastPage")) return { ok: false, message: "结束页必须是大于 0 的整数。" };
  if (lastPage !== undefined && firstPage === undefined) return { ok: false, message: "填写结束页时请先填写起始页，或留空页码范围。" };
  if (firstPage !== undefined && lastPage !== undefined && firstPage > lastPage) return { ok: false, message: "起始页不能大于结束页。" };
  return { ok: false, message: "请检查选择的真题和页码范围后重试。" };
}

function isUnresolvedStatus(value: unknown): boolean {
  return value === "pending" || value === "unknown";
}

function isPendingConflict(body: unknown, clientKey: string, papers: CourseExamOverview["papers"]): boolean {
  const existing = papers.find(paper => paper.clientKey === clientKey);
  if (existing && isUnresolvedStatus(existing.status)) return true;
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  if (record.pending === true || isUnresolvedStatus(record.status)) return true;
  const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null;
  if (error && (error.pending === true || isUnresolvedStatus(error.status) || isUnresolvedStatus(error.reason))) return true;
  const message = typeof error?.message === "string" ? error.message : typeof record.message === "string" ? record.message : "";
  return message.includes("尚未收到完整") || message.includes("正在生成");
}

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
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record = body && typeof body === "object" ? body as { error?: { message?: unknown }; message?: unknown } : null;
      const message = typeof record?.error?.message === "string" ? record.error.message
        : typeof record?.message === "string" ? record.message
        : "考前练习暂时无法读取，请重试。";
      throw new CourseExamHttpError(response.status, body, message);
    }
    const result = courseExamOverviewSchema.parse(body);
    if (!mounted.current) return result;
    const savedPending = pending.current;
    setData(result);
    const current = savedPending && result.papers.find(paper => paper.clientKey === savedPending.clientKey);
    if (current && (current.status === "ready" || current.status === "failed")) { store.clear(); pending.current = null; }
    if (!pending.current) {
      const selectedSource = savedPending?.sourceId ?? sourceId;
      if (!selectedSource) setSourceId(result.sources[0]?.id ?? "");
      else if (!sourceAvailable(result.sources, selectedSource)) {
        setSourceId("");
        setError("已选择的材料已不可用，请重新选择。");
      }
    }
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
        catch (reason) { if (mounted.current) setError(userFacingMessage(reason, "还没拿到组卷结果，请稍后刷新。")); }
      } catch (reason) {
        if (mounted.current) { setRecoveryBlocked(true); setError(userFacingMessage(reason, "没能恢复刚才的操作，请再试一次。")); }
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
    catch (reason) { if (mounted.current) setError(userFacingMessage(reason, "读取失败，请重试。")); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  const canGenerate = Boolean(pending.current) || sourceAvailable(data.sources, sourceId);
  async function generate() {
    if (flight.current || recovering || recoveryBlocked || !canGenerate) return;
    let input: CourseExamInput;
    if (pending.current) {
      const parsed = courseExamInputSchema.safeParse(pending.current);
      if (!parsed.success) {
        setError("当前组卷请求信息异常，请另开一份练习后重试。");
        return;
      }
      input = parsed.data;
    } else {
      const validated = validateCourseExamInput({ sourceId, questionCount, firstPage, lastPage });
      if (!validated.ok) {
        setError(validated.message);
        return;
      }
      input = validated.input;
    }
    flight.current = true;
    setBusy(true); setError("");
    try {
      store.write(input); pending.current = input;
      await readResponse(await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pending.current) }));
    } catch (reason) {
      const deterministicReject = reason instanceof CourseExamHttpError
        && (reason.status === 400 || (reason.status === 409 && !isPendingConflict(reason.body, input.clientKey, data.papers)));
      if (deterministicReject) {
        try {
          store.clear();
          pending.current = null;
        } catch (clearReason) {
          if (mounted.current) setError(userFacingMessage(clearReason, "无法清除原组卷请求，请另开一份。"));
          return;
        }
      }
      if (mounted.current) {
        setError(userFacingMessage(reason, deterministicReject ? "组卷条件无效或当前无法使用，请调整后重试。" : "组卷尚未完成，请刷新查看。"));
      }
    }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  function startAnother() {
    try {
      store.clear();
      pending.current = null;
      setRecoveryBlocked(false);
      if (sourceId && !sourceAvailable(data.sources, sourceId)) {
        setSourceId("");
        setError("已选择的材料已不可用，请重新选择。");
      } else setError("已准备另开一份；再次组卷会重新调用模型。");
    }
    catch (reason) { setError(userFacingMessage(reason, "尚未另开一份。")); }
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
        <label className="block text-sm">选择真题或样卷<select className={ui.input} value={sourceId} disabled={locked} onChange={event => { setSourceId(event.target.value); setError(""); }}>
          <option value="">请选择</option>{data.sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select></label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">题量<select className={ui.input} value={questionCount} disabled={locked} onChange={event => { setQuestionCount(Number(event.target.value)); setError(""); }}>{[3,5,8,10].map(count => <option key={count} value={count}>{count} 题</option>)}</select></label>
          <details className="text-sm" open={Boolean(firstPage || lastPage)}><summary className="min-h-10 cursor-pointer py-2 text-text-2">限定页码</summary><div className="mt-1 flex gap-2">
          <label className="text-sm">起始页<input className={`${ui.input} w-24`} type="number" min={1} value={firstPage} disabled={locked} onChange={event => { setFirstPage(event.target.value); setError(""); }} /></label>
          <label className="text-sm">结束页<input className={`${ui.input} w-24`} type="number" min={1} value={lastPage} disabled={locked} onChange={event => { setLastPage(event.target.value); setError(""); }} /></label>
          </div></details>
        </div>
        <button type="button" className={ui.primary} disabled={busy || recovering || recoveryBlocked || !canGenerate} onClick={generate}>{recovering ? "正在核对原组卷…" : busy ? "正在准备…" : pending.current ? "查看这次组卷结果" : "分析考点并组卷"}</button>
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
