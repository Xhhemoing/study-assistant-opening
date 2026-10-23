"use client";

import type { CourseGoal, PlanDraft, TaskItem } from "@aistudy/contracts";
import { localDateKeyInZone, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useEffect, useMemo, useRef, useState } from "react";
import { createOpeningApi, type OpeningApi, type TodayPlanRead } from "../client/api";
import { useConversationObjectHref } from "../assistant/conversation-object-context";
import { LoadingRows, PageHeader, ui } from "../design/ui";
import { planAcceptFailure } from "../planning/plan-accept-errors";
import { clearSprintCheckpoint, readSprintCheckpoint, resumeSprintAcceptance, saveSprintCheckpoint, sprintAcceptance, type SprintCheckpoint } from "./sprint-checkpoint";
import { sprintCandidateBlocks, sprintPlanChanges, sprintTaskHref, sprintTaskTitle, sprintTodayTasks } from "./sprint-plan-model";

type SprintApi = Pick<OpeningApi, "getPlanningSettings" | "getAdaptivePrefs" | "getToday" | "listTasks" | "proposePlan" | "acceptPlan" | "rejectPlan">;
type SprintData = { plan: TodayPlanRead; tasks: TaskItem[]; goal: CourseGoal | null; timeZone: string };
const timeLabel = (value: string, timeZone: string) => new Date(value).toLocaleTimeString("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });

/** Existing workspace plan and draft; only explicit confirmation changes the plan. */
type Props = { courseId: string; courseTitle: string; api?: SprintApi };
export function SprintBoard(props: Props) { return <SprintBoardContent key={props.courseId} {...props} />; }

function SprintBoardContent({ courseId, courseTitle, api: suppliedApi }: Props) {
  const objectHref = useConversationObjectHref();
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const [data, setData] = useState<SprintData | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [options, setOptions] = useState<PlanDraft[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<SprintCheckpoint | null>(null);
  const [recoveryProblem, setRecoveryProblem] = useState("");
  const checkpointRef = useRef<SprintCheckpoint | null>(null);
  const flight = useRef(false);
  const mounted = useRef(true);
  const pendingApplication = Boolean(checkpoint?.acceptInput);
  function remember(value: SprintCheckpoint) {
    saveSprintCheckpoint(value);
    checkpointRef.current = value; setCheckpoint(value);
  }

  async function read(): Promise<SprintData> {
    const [settings, prefs] = await Promise.all([api.getPlanningSettings(), api.getAdaptivePrefs()]);
    if (settings.invalidStoredSettings || prefs.invalidStoredPrefs) throw new Error("学习安排暂时无法读取，请在设置中检查后重试。");
    const timeZone = resolveWorkspaceTimeZone(settings.settings?.timeZone);
    const date = localDateKeyInZone(new Date(), timeZone);
    const [plan, result] = await Promise.all([api.getToday(date), api.listTasks()]);
    if (plan.date !== date) throw new Error("读取到的计划日期已改变，请重新读取当天计划。");
    return { plan, tasks: result.tasks, timeZone, goal: prefs.prefs.courseGoals[courseId] ?? null };
  }
  function hydrate(next: SprintData) {
    setData(next);
    const recovery = readSprintCheckpoint(courseId, next.plan.date);
    const saved = recovery.kind === "saved" ? recovery.checkpoint : null;
    checkpointRef.current = saved; setCheckpoint(saved);
    setRecoveryProblem(recovery.kind === "invalid" || recovery.kind === "obsolete" ? recovery.message : "");
    const daily = next.plan.dailyDraft?.status === "draft" ? next.plan.dailyDraft : null;
    setOptions(saved ? [saved.draft, ...(daily && daily.id !== saved.draft.id ? [daily] : [])] : daily ? [daily] : []);
    setPreviewId(saved?.draft.id ?? null);
  }
  function discardRecovery() {
    if (flight.current || !data) return;
    try {
      clearSprintCheckpoint(courseId);
      checkpointRef.current = null; setCheckpoint(null); setRecoveryProblem(""); setError(""); setMessage("");
      setOptions(data.plan.dailyDraft?.status === "draft" ? [data.plan.dailyDraft] : []); setPreviewId(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "清除恢复记录失败。"); }
  }
  async function refresh() {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError("");
    try { const next = await read(); if (mounted.current) hydrate(next); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "读取失败，请重试。"); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
    // CourseSprintMode keys this component by course identity.
  }, [api, courseId]);

  async function propose() {
    if (flight.current || !data || recoveryProblem || checkpointRef.current?.acceptInput) return;
    if (localDateKeyInZone(new Date(), data.timeZone) !== data.plan.date) {
      await refresh();
      if (mounted.current) setMessage("日期已改变，请核对今天的计划后重新选择候选。");
      return;
    }
    flight.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const draft = await api.proposePlan({ date: data.plan.date, clientKey: `sprint-propose:${crypto.randomUUID()}` });
      if (!mounted.current) return;
      remember({ version: 1, courseId, date: data.plan.date, draft, acceptInput: null });
      setOptions(previous => [...previous.filter(item => item.id !== draft.id), draft]);
      setPreviewId(draft.id);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "未能生成候选，当前安排仍保留。"); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  const preview = options.find(option => option.id === previewId) ?? null;
  async function apply(recover = false) {
    const saved = checkpointRef.current;
    const candidate = recover ? saved?.draft : preview;
    if (flight.current || !candidate || !data || recoveryProblem || candidate.date !== data.plan.date) return;
    if (!recover && localDateKeyInZone(new Date(), data.timeZone) !== data.plan.date) {
      await refresh();
      if (mounted.current) setMessage("日期已改变，旧候选尚未应用。请核对今天的计划。");
      return;
    }
    // An uncertain request can only be replayed exactly, even if another plan version is now current.
    if (!recover && (saved?.acceptInput || candidate.baseVersion !== data.plan.acceptedVersion)) return;
    if (recover && !saved?.acceptInput) return;
    flight.current = true; setBusy(true); setError(""); setMessage("");
    let applied = false, sent = false;
    try {
      const input = recover ? saved!.acceptInput! : sprintAcceptance(candidate);
      const recovery: SprintCheckpoint = { version: 1, courseId, date: data.plan.date, draft: candidate, acceptInput: input };
      remember(recovery);
      sent = true;
      const result = await resumeSprintAcceptance(courseId, recovery.date, input, api);
      if (result.id !== input.draftId || result.date !== recovery.date || result.status !== "accepted" || result.version <= input.expectedBaseVersion) throw new Error("应用回执尚未核实，请保留原请求并重新读取。");
      applied = true;
      if (!mounted.current) return;
      setMessage("安排已应用，正在刷新任务…");
      const next = await read();
      if (!mounted.current) return;
      if (next.plan.date === recovery.date && next.plan.acceptedVersion < result.version) throw new Error("当前计划尚未同步，请重新读取。");
      clearSprintCheckpoint(courseId);
      hydrate(next); setAdjusting(false); setMessage("安排已应用。");
    } catch (reason) {
      if (!mounted.current) return;
      setError(applied ? "安排已应用，任务暂未刷新。请重新读取最新计划，并核对原应用请求。" : sent ? `${planAcceptFailure(reason).message} 原计划、候选和应用请求已保留；请重新读取后核对或重试原请求。` : reason instanceof Error ? reason.message : "恢复记录保存失败，尚未发送应用请求。");
      if (applied) { setData(null); setMessage(""); }
    } finally { flight.current = false; if (mounted.current) setBusy(false); }
  }

  const today = data ? sprintTodayTasks(data.tasks, data.plan.blocks, courseId) : [];
  const next = today.find(item => item.actionable);
  const changes = data && preview ? sprintPlanChanges(data.plan.blocks, preview, data.tasks) : [];
  const minutes = today.reduce((sum, item) => sum + Math.round((Date.parse(item.block.end) - Date.parse(item.block.start)) / 60000), 0);
  const facts = [courseTitle, data?.goal?.targetDate ? `目标 ${data.goal.targetDate}` : null, data && today.length ? `今天已安排 ${minutes} 分钟` : null].filter(Boolean).join(" · ");
  return <section className="space-y-6">
    <PageHeader title="考前冲刺" actions={<div className="flex flex-wrap items-center gap-3"><p className="text-sm text-text-2">{facts}</p>{next ? <Link className={ui.primary} href={objectHref(sprintTaskHref(next.task))}>开始：{next.task.title}</Link> : <Link className={ui.secondary} href={objectHref(`/opening/courses/${encodeURIComponent(courseId)}/study`)}>从课程继续</Link>}</div>} />
    <div className="space-y-6 px-5 pb-5 sm:px-7">
      {error ? <div role="alert" className="space-y-2 text-sm text-danger"><p>{error}</p><button type="button" className={ui.secondary} disabled={busy} onClick={() => void refresh()}>重新读取计划</button></div> : null}
      {data && recoveryProblem ? <div role="alert" className="space-y-2"><p className="text-sm text-warn">{recoveryProblem}</p><button type="button" className={ui.secondary} disabled={busy} onClick={discardRecovery}>清除恢复记录</button></div> : null}
      {data && pendingApplication ? <div className="space-y-2 rounded-md bg-warn-soft p-3"><p role="status" className="text-sm text-warn">应用请求已保留，结果尚未确认。当前任务来自服务器；不会自动重复应用。</p><div className="flex flex-wrap gap-2"><button type="button" className={ui.primary} disabled={busy || Boolean(recoveryProblem)} onClick={() => void apply(true)}>{busy ? "正在核对…" : "核对并重试原应用"}</button><button type="button" className={ui.quiet} disabled={busy} onClick={discardRecovery}>仅清除恢复记录</button></div><p className="text-xs text-text-2">清除只移除本页恢复入口，不会撤销服务器上的安排。</p></div> : null}
      {message ? <p role="status" className="text-sm text-text-2">{message}</p> : null}
      {!data && busy ? <LoadingRows label="正在读取当前计划…" /> : data ? <>
        <section aria-labelledby="sprint-today-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="sprint-today-title" className="text-sm font-medium">今天的任务</h2><button type="button" className={ui.quiet} disabled={busy} onClick={() => void refresh()}>刷新计划</button></div>
          {today.length ? <ol className="divide-y divide-line border-y border-line">{today.map(({ task, block, actionable }) => <li key={`${task.id}-${block.start}`} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">{actionable ? <Link className="min-w-0 break-words text-sm text-text underline decoration-line underline-offset-4" href={objectHref(sprintTaskHref(task))}>{task.title}</Link> : <span className="text-sm text-text-2">{task.title} · {task.status === "done" ? "已完成" : task.status === "skipped" ? "已跳过" : "尚未到开始时间"}</span>}<span className="text-xs tabular-nums text-text-2">{timeLabel(block.start, data.timeZone)}–{timeLabel(block.end, data.timeZone)}</span></div>
            {block.reason ? <p className="mt-1 text-xs text-text-2">{block.reason}</p> : null}
          </li>)}</ol> : <p className="text-sm text-text-2">今天还没有这门课的已确认任务。可以先从课程继续，或展开调整安排。</p>}
        </section>
        <section aria-label="调整安排" className="space-y-3">
          <button type="button" className={ui.quiet} aria-expanded={adjusting} aria-controls="sprint-adjustments" disabled={busy} onClick={() => { if (!flight.current) setAdjusting(value => !value); }}>{adjusting ? "收起调整" : "调整安排"}</button>
          {adjusting ? <div id="sprint-adjustments" className="space-y-4">
            <p className="text-xs text-text-2">候选包含今天所有课程的共同安排。确认应用后才会替换今天的计划。</p>
            <fieldset disabled={busy || pendingApplication || Boolean(recoveryProblem)} className="space-y-2"><legend className="sr-only">候选安排</legend>{options.map((option, index) => <label key={option.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line p-3 has-[:checked]:border-accent"><input type="radio" name="sprint-option" checked={previewId === option.id} onChange={() => { if (!flight.current && !checkpointRef.current?.acceptInput && !recoveryProblem) {
              try { remember({ version: 1, courseId, date: data.plan.date, draft: option, acceptInput: null }); setPreviewId(option.id); setError(""); }
              catch (reason) { setError(reason instanceof Error ? reason.message : "候选未能保存，请重试。"); }
            } }} className="accent-accent" /><span className="text-sm">候选 {index + 1} · {sprintCandidateBlocks(option).length} 项安排</span></label>)}</fieldset>
            <button type="button" className={ui.secondary} disabled={busy || pendingApplication || Boolean(recoveryProblem)} onClick={() => void propose()}>{busy ? "正在处理…" : options.length ? "重新生成候选" : "生成候选安排"}</button>
            {preview ? <div className="space-y-3 rounded-md bg-surface-2 p-4">
              <p className="text-sm font-medium">{pendingApplication ? "上次候选预览，应用结果待核对" : "变化预览，尚未生效"}</p>
              <ul className="space-y-2 text-sm" aria-label="安排变化">{changes.map((change, index) => <li key={index}>{change.kind}：{change.title}{change.block ? ` · ${timeLabel(change.block.start, data.timeZone)}–${timeLabel(change.block.end, data.timeZone)}` : ""}</li>)}</ul>
              {!changes.length ? <p className="text-sm text-text-2">候选与当前安排一致。</p> : null}
              <details><summary className="min-h-11 cursor-pointer py-2 text-xs text-text-2">完整候选安排</summary><ol className="space-y-2 text-sm">{sprintCandidateBlocks(preview).map(block => <li key={`${block.taskId}-${block.start}`}>{sprintTaskTitle(block.taskId, data.tasks, preview)} · {timeLabel(block.start, data.timeZone)}–{timeLabel(block.end, data.timeZone)}{block.reason ? <p className="text-xs text-text-2">{block.reason}</p> : null}</li>)}</ol></details>
              {preview.unscheduledTaskIds.length ? <p className="text-xs text-warn">有 {preview.unscheduledTaskIds.length} 项未排入今天，不会因此标记完成。</p> : null}
              {preview.baseVersion !== data.plan.acceptedVersion ? <p className="text-sm text-warn">{pendingApplication ? "当前计划已变化，请先核对原应用请求。" : "当前计划已变化，请刷新计划后重新生成候选。"}</p> : null}
              <div className="flex flex-wrap gap-2"><button type="button" className={ui.primary} disabled={busy || pendingApplication || Boolean(recoveryProblem) || preview.baseVersion !== data.plan.acceptedVersion} onClick={() => void apply()}>{busy ? "正在应用…" : "确认应用这个安排"}</button><button type="button" className={ui.quiet} disabled={busy || pendingApplication || Boolean(recoveryProblem)} onClick={() => { if (!flight.current && !checkpointRef.current?.acceptInput) {
                try { clearSprintCheckpoint(courseId); checkpointRef.current = null; setCheckpoint(null); setPreviewId(null); setError(""); }
                catch (reason) { setError(reason instanceof Error ? reason.message : "取消预览失败，请重试。"); }
              } }}>取消预览</button></div>
            </div> : null}
            <Link className={ui.quiet} href="/opening/settings/planning">时间与完整学习安排</Link>
          </div> : null}
        </section>
      </> : null}
    </div>
  </section>;
}
