"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarDays, ChevronDown, Circle, CircleCheck, Clock3 } from "lucide-react";
import type { OpeningApi } from "../client/api";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { buttonClass, inputClass, secondaryButtonClass } from "../design/ui";
import { canAcceptPlan } from "./plan-action";
import { canProposePlan } from "./plan-input";
import { focusTodayTask, visibleTodayTasks } from "./today-task-selection";
import type { StudyTask } from "./study-task";
import { TodayPlanOverview } from "./today-overview";

type SelectionSource = "focus" | "user";
type Props = { api?: OpeningApi; date?: string; focusTaskId?: string; selectedId?: string; onSelect?: (task: StudyTask, source?: SelectionSource) => void };
type TaskLoadState = "loading" | "ready" | "error";
type TodayTasks = Awaited<ReturnType<OpeningApi["listTasks"]>>["tasks"];
export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function timeLabel(value: string): string { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }); }
export function TodayPlanView({ api: supplied, date = localDateKey(), focusTaskId, selectedId, onSelect }: Props) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const [tasks, setTasks] = useState<TodayTasks>([]);
  const [loadState, setLoadState] = useState<TaskLoadState>("loading");
  const [plan, setPlan] = useState<Awaited<ReturnType<OpeningApi["getToday"]>> | null>(null);
  const [reminders, setReminders] = useState<Awaited<ReturnType<OpeningApi["listReminders"]>> | null>(null);
  const [draft, setDraft] = useState<Awaited<ReturnType<OpeningApi["proposePlan"]>> | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [freeStart, setFreeStart] = useState(""), [freeEnd, setFreeEnd] = useState("");
  const [planning, setPlanning] = useState(false), [all, setAll] = useState(false), [doneView, setDoneView] = useState(false);
  const refresh = useCallback(async () => {
    setLoadState("loading"); setError("");
    try {
      const [nextTasks, nextPlan, nextReminders] = await Promise.all([api.listTasks(), api.getToday(date), api.listReminders()]);
      setTasks(nextTasks.tasks); setPlan(nextPlan); setReminders(nextReminders); setLoadState("ready");
    } catch (reason) { setLoadState("error"); setError(reason instanceof Error ? reason.message : "计划暂时无法读取"); }
  }, [api, date]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (loadState !== "ready" || !onSelect) return;
    const next = tasks.find((task) => task.id === selectedId) ?? tasks.find((task) => task.id === focusTaskId) ?? tasks.find((task) => task.status === "pending");
    if (next) onSelect({ ...next, reason: plan?.blocks.find((block) => block.taskId === next.id)?.reason }, "focus");
  }, [focusTaskId, loadState, onSelect, plan, selectedId, tasks]);
  async function propose() {
    setPending(true); setError("");
    try {
      const newFree = canProposePlan({ start: freeStart, end: freeEnd }) ? [{ start: new Date(freeStart).toISOString(), end: new Date(freeEnd).toISOString(), kind: "free" as const }] : [];
      if (!newFree.length) { setError("请先填写一个有效的可用时间段。"); return; }
      setDraft(await api.proposePlan({ date, free: [...(plan?.hardBlocks ?? []), ...newFree], clientKey: `today-plan-${date}` }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "计划生成失败"); }
    finally { setPending(false); }
  }
  async function accept() {
    if (!draft || !canAcceptPlan({ pending, stale: draft.baseVersion !== plan?.acceptedVersion })) return;
    setPending(true); setError("");
    try { await api.acceptPlan({ draftId: draft.id, expectedBaseVersion: draft.baseVersion, clientKey: `accept-plan-${draft.id}` }); setDraft(null); await refresh(); }
    catch (reason) { setError(reason instanceof OpeningApiError && reason.status === 409 ? "计划已变化，请重新读取后再确认；没有重复提交。" : reason instanceof Error ? reason.message : "计划确认失败"); }
    finally { setPending(false); }
  }
  async function reject() {
    if (!draft || pending) return;
    setPending(true); setError("");
    try { await api.rejectPlan(draft.id); setDraft(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "计划取消失败，草案已保留，请重试。"); }
    finally { setPending(false); }
  }
  const remaining = tasks.filter((task) => task.status === "pending"), done = tasks.filter((task) => task.status === "done");
  const displayed = doneView ? done : tasks;
  const visibleCount = doneView ? Math.min(done.length, 3) : visibleTodayTasks(tasks, focusTaskId).filter((task) => task.status === "pending").length;
  return <section className="flex min-h-full flex-col" aria-label="今日计划">
    <div className="px-4 pb-3 pt-4"><div className="flex items-center justify-between"><h2 className="text-xs font-semibold text-zinc-700">学习队列</h2><button type="button" aria-label="安排时间" aria-expanded={planning} aria-controls="opening-plan-editor" className={secondaryButtonClass} onClick={() => setPlanning(!planning)}><CalendarDays size={15} aria-hidden /></button></div><p className="mt-1 text-[11px] text-zinc-500">{loadState === "ready" ? `全部待办 ${remaining.length} 项 · 预计 ${remaining.reduce((sum, task) => sum + task.minutes, 0)} 分钟` : loadState === "error" ? "任务读取失败" : "正在读取任务"}</p></div>
    <div className="mx-4 mb-3 flex rounded-md bg-zinc-200/60 p-0.5" aria-label="队列筛选">{[false, true].map((completed) => <button key={String(completed)} type="button" aria-pressed={doneView === completed} onClick={() => { setDoneView(completed); setAll(false); }} className={`min-h-10 flex-1 rounded px-2 text-xs transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-emerald-700 motion-reduce:transition-none md:min-h-8 ${doneView === completed ? "bg-white font-medium text-zinc-800" : "text-zinc-600 hover:text-zinc-800"}`}>{completed ? `已完成 ${done.length}` : `待办 ${remaining.length}`}</button>)}</div>
    {error ? <div className="mx-3 mb-3 border border-red-200 bg-red-50 p-3"><p className="text-xs leading-5 text-red-700" role="alert">{error}</p><button type="button" onClick={() => void refresh()} disabled={loadState === "loading" || pending} className={`${secondaryButtonClass} mt-2`}>重新读取</button></div> : null}
    <TodayTaskList tasks={displayed} state={loadState} focusTaskId={doneView ? undefined : focusTaskId} selectedId={selectedId} onSelect={onSelect} plan={plan} showAll={all} doneView={doneView} />
    {(doneView ? done.length : remaining.length) > (doneView ? 3 : visibleCount) ? <button type="button" className={`${secondaryButtonClass} mx-3 mt-2`} aria-expanded={all} onClick={() => setAll(!all)}>{all ? "收起列表" : `查看全部 ${doneView ? done.length : remaining.length} 项`}<ChevronDown size={12} aria-hidden /></button> : null}
    {loadState === "ready" && plan ? <TodayPlanOverview tasks={tasks} plan={plan} onArrange={() => setPlanning(true)} /> : null}
    {planning ? <div id="opening-plan-editor" className="mt-3 space-y-3 border-y border-zinc-200 px-4 py-4">
      <h3 className="text-xs font-semibold text-zinc-800">安排可用时间</h3>
      <label className="block text-xs text-zinc-600">开始<input aria-label="可用时间开始" type="datetime-local" value={freeStart} onChange={(event) => setFreeStart(event.target.value)} className={`${inputClass} mt-1`} disabled={pending} /></label>
      <label className="block text-xs text-zinc-600">结束<input aria-label="可用时间结束" type="datetime-local" value={freeEnd} onChange={(event) => setFreeEnd(event.target.value)} className={`${inputClass} mt-1`} disabled={pending} /></label>
      <button type="button" onClick={() => void propose()} disabled={pending || Boolean(draft) || loadState !== "ready" || !canProposePlan({ start: freeStart, end: freeEnd })} className={`${buttonClass} w-full`}>{pending ? "正在处理…" : "生成计划"}</button>
      {plan?.blocks.length ? <details><summary className="min-h-10 cursor-pointer py-2 text-xs text-zinc-600">已确认安排 · {plan.blocks.length} 个时间块</summary><ul className="space-y-2 text-xs leading-5 text-zinc-600">{plan.blocks.map((block) => <li key={`${block.taskId}-${block.start}`}><span className="font-medium text-zinc-800">{tasks.find((task) => task.id === block.taskId)?.title ?? "学习任务"}</span><p>{timeLabel(block.start)}–{timeLabel(block.end)}</p><p>{block.reason}</p></li>)}</ul></details> : null}
      {draft ? <div className="space-y-3 border-t border-zinc-200 pt-3"><p className="text-xs font-semibold text-zinc-900">计划变更预览</p><p className="text-xs leading-5 text-zinc-600">当前 {plan?.blocks.length ?? 0} 个时间块 → 草案 {draft.blocks.length} 个时间块；未安排 {draft.unscheduledTaskIds.length} 项。</p>
        <ul className="space-y-2 text-xs leading-5 text-zinc-600">{draft.blocks.map((block) => <li key={`${block.taskId}-${block.start}`}><span className="font-medium text-zinc-800">{tasks.find((task) => task.id === block.taskId)?.title ?? "学习任务"}</span><p>{timeLabel(block.start)}–{timeLabel(block.end)}</p><p>{block.reason}</p></li>)}</ul>
        {draft.baseVersion !== plan?.acceptedVersion ? <p className="text-xs leading-5 text-amber-800">计划版本已变化。请取消旧草案，重新生成后确认。</p> : null}
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void accept()} disabled={!canAcceptPlan({ pending, stale: draft.baseVersion !== plan?.acceptedVersion })} className={buttonClass}>确认变更</button><button type="button" onClick={() => void reject()} disabled={pending} className={secondaryButtonClass}>取消草案</button></div>
      </div> : null}
    </div> : null}
    <div className="mt-auto px-4 pb-4 pt-6"><p className="text-[11px] leading-5 text-zinc-500">队列包含历史任务，已完成不等于今日完成。<br />选择任务后继续；计时与浏览不会自动标记完成。</p>
      {reminders ? <details className="mt-3 border-t border-zinc-200 pt-2 text-[11px] text-zinc-500"><summary className="cursor-pointer py-2 focus-visible:ring-2 focus-visible:ring-emerald-700">提醒状态 · {reminders.reminders.length} 项</summary><p className="py-1 leading-5">外部渠道：{reminders.externalDelivery === "configured" ? "已配置" : "未配置"}；应用内列表不代表已送达。</p><ul className="space-y-1">{reminders.reminders.map((reminder) => <li key={reminder.id}>{reminder.status === "sent" && reminder.receiptId ? "已收到提供方回执" : reminder.outcome === "unknown" ? "发送结果未知，请勿自动重试" : reminder.outcome === "quiet" ? "静默时段，暂不发送" : reminder.outcome === "rate_limited" ? "提供方限流" : reminder.channel === "in_app" ? "应用内提醒" : "外部提醒未送达"}</li>)}</ul></details> : null}
    </div>
  </section>;
}
export function TodayTaskList({ tasks, state, focusTaskId, selectedId, onSelect, plan, showAll = false, doneView = false }: {
  tasks: TodayTasks; state: TaskLoadState; focusTaskId?: string; selectedId?: string; onSelect?: (task: StudyTask, source?: SelectionSource) => void;
  plan?: Awaited<ReturnType<OpeningApi["getToday"]>> | null; showAll?: boolean; doneView?: boolean;
}) {
  const focusRef = useCallback((element: HTMLLIElement | null) => focusTodayTask(element, focusTaskId), [focusTaskId]);
  if (state === "loading") return <p className="px-4 py-5 text-xs text-zinc-500" role="status">正在加载任务…</p>;
  if (state === "error") return <p className="px-4 py-5 text-xs text-red-700">任务暂时无法读取，请重试。</p>;
  const visibleTasks = doneView ? tasks.slice(0, showAll ? undefined : 3) : showAll ? [...tasks.filter((task) => task.id === focusTaskId), ...tasks.filter((task) => task.status === "pending" && task.id !== focusTaskId)] : visibleTodayTasks(tasks, focusTaskId);
  if (!visibleTasks.length) return <div className="px-4 py-6"><p className="text-sm text-zinc-700">{doneView ? "尚无已完成任务。" : "暂无待完成任务。"}</p><p className="mt-2 text-xs leading-6 text-zinc-500">继续探索或整理笔记，无需先创建任务。</p></div>;
  return <ul className="border-y border-zinc-200/80" aria-label="学习任务列表">{visibleTasks.map((task) => {
    const block = plan?.blocks.find((entry) => entry.taskId === task.id), active = task.id === selectedId;
    return <li key={task.id} id={`task-${task.id}`} ref={task.id === focusTaskId ? focusRef : undefined} tabIndex={task.id === focusTaskId ? -1 : undefined} className="scroll-mt-6 border-b border-zinc-200/70 last:border-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-700">
      <button type="button" aria-pressed={active} onClick={() => onSelect?.({ ...task, reason: block?.reason }, "user")} className={`group flex min-h-[76px] w-full items-start gap-2.5 border-l px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700 motion-reduce:transition-none ${active ? "border-emerald-600 bg-emerald-50/80" : "border-transparent hover:bg-zinc-100"}`}>
        {task.status === "done" ? <CircleCheck size={14} className="mt-1 shrink-0 text-emerald-700" aria-hidden /> : <Circle size={14} className={`mt-1 shrink-0 ${active ? "text-emerald-700" : "text-zinc-500"}`} aria-hidden />}
        <span className="min-w-0 flex-1"><span className="line-clamp-2 break-words text-xs font-medium leading-5 text-zinc-800">{task.title}</span><span className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500"><Clock3 size={11} aria-hidden />{task.minutes} 分钟<span aria-hidden>/</span>{task.status === "done" ? "已完成" : task.status === "skipped" ? "已跳过" : block ? `${timeLabel(block.start)}–${timeLabel(block.end)}` : "待安排"}</span></span>
        {active ? <ArrowRight size={12} className="mt-1 shrink-0 text-emerald-700" aria-hidden /> : null}
      </button>
    </li>;
  })}</ul>;
}
