"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CalendarDays, ChevronDown, Circle, CircleCheck, Clock3 } from "lucide-react";
import type { OpeningApi } from "../client/api";
import { createOpeningApi } from "../client/api";
import { buttonClass, inputClass, secondaryButtonClass } from "../design/ui";
import { canAcceptPlan } from "./plan-action";
import { canProposePlan, planProposalIntent, type PlanProposalIntent } from "./plan-input";
import { QuickAddTask } from "./quick-add-task";
import { ActionDigest } from "./action-digest";
import { LocalReplanCard } from "./local-replan-card";
import { DailyDraftCard } from "./daily-draft-card";
import { RetestProposals } from "./retest-proposals";
import { TodayStudyTools } from "./today-study-tools";
import { readTodayData } from "./today-data-loader";
import { focusTodayTask, selectTodayTask, visibleTodayTasks } from "./today-task-selection";
import type { StudyTask } from "./study-task";
import { TodayPlanOverview } from "./today-overview";
import { groupTodayQueue, previewTodayQueue, type TodayQueueTask } from "./today-queue-groups";
import { isRetestOriginTask, TaskPlanningTimeZoneContext, TaskStatusControl } from "./task-status-control";
import { TaskRowActions } from "./task-row-actions";
import { localDateKeyInZone, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { useOpeningCapabilities } from "../capabilities/capabilities-provider";
import { AutonomySwitcher } from "./autonomy-switcher";
import { CoachPlanControl } from "./coach-plan-control";
import { planAcceptFailure } from "./plan-accept-errors";
import { userFacingMessage } from "../../../lib/user-facing-error";

type SelectionSource = "focus" | "user";
type Props = {
  api?: OpeningApi;
  date?: string;
  focusTaskId?: string;
  selectedId?: string;
  reloadToken?: number;
  timeZone?: string;
  onSelect?: (task: StudyTask, source?: SelectionSource) => void;
  onClearSelection?: () => void;
  onEmptyChange?: (empty: boolean) => void;
};
type TaskLoadState = "loading" | "ready" | "error";
type TodayTasks = Awaited<ReturnType<OpeningApi["listTasks"]>>["tasks"];

/** Only confirmed empty data can release the desktop queue column. */
export function todayQueueIsEmpty(input: {
  tasksReady: boolean; planReady: boolean; taskCount: number;
  hasDraft: boolean; blockCount: number; unplannedCount: number;
}): boolean {
  return input.tasksReady && input.planReady && input.taskCount === 0
    && !input.hasDraft && input.blockCount === 0 && input.unplannedCount === 0;
}

const QUEUE_GROUP_LABELS = {
  confirmed: "今日已确认",
  dueRetests: "到期补测",
  overdue: "逾期",
  other: "其他待办",
} as const;

/**
 * Local calendar date key. With `timeZone` (the workspace zone supplied by the
 * server) the result is the business day in that zone, independent of the
 * browser/process zone. Without it, legacy device-local behaviour is kept for
 * callers that have not been migrated.
 */
export function localDateKey(date = new Date(), timeZone?: string): string {
  if (timeZone) return localDateKeyInZone(date, timeZone);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Workspace zone for Today. Uses the server-supplied workspace zone; when absent,
 * falls back to the workspace default (Asia/Shanghai) — never the browser zone.
 */
export function resolveTodayTimeZone(timeZone?: string | null): string {
  return resolveWorkspaceTimeZone(timeZone);
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function upcomingRetestHint(tasks: TodayQueueTask[], now: Date, timeZone: string, count: number): string | null {
  if (count <= 0) return null;
  let earliest: Date | null = null;
  for (const task of tasks) {
    if (task.status !== "pending" || task.recommendedAt == null || task.recommendedAt === "") continue;
    const at = new Date(task.recommendedAt);
    if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) continue;
    if (!earliest || at.getTime() < earliest.getTime()) earliest = at;
  }
  if (!earliest) return `${count} 项补测将于日后到期`;
  const day = earliest.toLocaleDateString("zh-CN", { timeZone, month: "numeric", day: "numeric" });
  return `${count} 项补测将于 ${day} 到期`;
}

export function TodayPlanView({
  api: supplied,
  date: dateProp,
  focusTaskId,
  selectedId,
  onSelect,
  onClearSelection,
  onEmptyChange,
  reloadToken = 0,
  timeZone: timeZoneProp,
}: Props) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const adaptivePlanning = useOpeningCapabilities().adaptivePlanning;
  const timeZone = resolveTodayTimeZone(timeZoneProp);
  const date = dateProp ?? localDateKey(new Date(), timeZone);
  const [tasks, setTasks] = useState<TodayTasks>([]);
  const [loadState, setLoadState] = useState<TaskLoadState>("loading");
  const [plan, setPlan] = useState<Awaited<ReturnType<OpeningApi["getToday"]>> | null>(null);
  const [planWarning, setPlanWarning] = useState("");
  const [planState, setPlanState] = useState<TaskLoadState>("loading");
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const readEpoch = useRef(0);
  const proposalIntent = useRef<PlanProposalIntent | null>(null);
  const [draft, setDraft] = useState<Awaited<ReturnType<OpeningApi["proposePlan"]>> | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [freeStart, setFreeStart] = useState(""), [freeEnd, setFreeEnd] = useState("");
  const [planning, setPlanning] = useState(false), [all, setAll] = useState(false), [doneView, setDoneView] = useState(false);
  const [nowTick, setNowTick] = useState(() => new Date());
  const [coachSettingsRevision, setCoachSettingsRevision] = useState(0);
  const refresh = useCallback(async (options?: { refreshSuggestions?: boolean }) => {
    const epoch = ++readEpoch.current;
    setLoadState("loading"); setError(""); setPlanWarning(""); setPlanState("loading");
    await readTodayData(api, date, {
      isCurrent: () => epoch === readEpoch.current,
      tasks: (next) => { setTasks(next); setNowTick(new Date()); setLoadState("ready"); setHasLoadedTasks(true); },
      plan: (next) => { setPlan(next); setPlanState("ready"); },
      taskError: (reason) => {
        setTasks([]); setLoadState("error"); onClearSelection?.();
        setError(userFacingMessage(reason, "任务暂时无法读取"));
      },
      planError: () => { setPlanState("error"); setPlanWarning("今日安排暂时无法读取，仍可选择任务学习；恢复前暂停生成和确认计划。"); },
    }, options);
  }, [api, date, onClearSelection]);
  useEffect(() => {
    void refresh();
    return () => { readEpoch.current += 1; };
  }, [refresh]);
  useEffect(() => {
    // Re-evaluate due retests while the page stays open, without polling APIs.
    const updateTime = () => setNowTick(new Date());
    const timer = window.setInterval(updateTime, 30_000);
    window.addEventListener("focus", updateTime);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", updateTime); };
  }, []);
  const appliedReloadToken = useRef(reloadToken);
  useEffect(() => {
    if (appliedReloadToken.current === reloadToken) return;
    appliedReloadToken.current = reloadToken;
    void refresh();
  }, [reloadToken, refresh]);
  const queueEmpty = todayQueueIsEmpty({
    tasksReady: loadState === "ready", planReady: planState === "ready",
    taskCount: tasks.length, hasDraft: Boolean(draft || plan?.dailyDraft?.status === "draft"),
    blockCount: plan?.blocks.length ?? 0, unplannedCount: plan?.unplannedPendingCount ?? 0,
  });
  useEffect(() => { onEmptyChange?.(queueEmpty); }, [queueEmpty, onEmptyChange]);
  const draftIsStale = Boolean(draft && (draft.baseVersion !== plan?.acceptedVersion || proposalIntent.current?.date !== date));
  async function propose() {
    if (pending || draft || !plan || planState !== "ready" || loadState !== "ready") return;
    setPending(true); setError("");
    try {
      const newFree = canProposePlan({ start: freeStart, end: freeEnd }) ? [{ start: new Date(freeStart).toISOString(), end: new Date(freeEnd).toISOString(), kind: "free" as const }] : [];
      if (!newFree.length) { setError("请先填写一个有效的可用时间段。"); return; }
      const free = [...(plan.hardBlocks ?? []), ...newFree];
      proposalIntent.current = planProposalIntent(proposalIntent.current, { date, free, baseVersion: plan.acceptedVersion }, () => `today-plan-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`);
      setDraft(await api.proposePlan({ date, free, clientKey: proposalIntent.current.clientKey }));
    } catch (reason) { setError(userFacingMessage(reason, "计划生成失败")); }
    finally { setPending(false); }
  }
  async function accept() {
    if (loadState !== "ready" || planState !== "ready" || !draft || !canAcceptPlan({ pending, stale: draftIsStale })) return;
    setPending(true); setError("");
    try { await api.acceptPlan({ draftId: draft.id, expectedBaseVersion: draft.baseVersion, clientKey: `accept-plan-${draft.id}-${draft.baseVersion}`, acceptSuggestedKeys: [] }); setDraft(null); proposalIntent.current = null; await refresh(); }
    catch (reason) { const failure = planAcceptFailure(reason); if (failure.reread) await refresh(); setError(failure.message); }
    finally { setPending(false); }
  }
  async function reject() {
    if (!draft || pending) return;
    setPending(true); setError("");
    try { await api.rejectPlan(draft.id); setDraft(null); proposalIntent.current = null; }
    catch (reason) { setError(userFacingMessage(reason, "计划取消失败，草案已保留，请重试。")); }
    finally { setPending(false); }
  }
  const queueTasks = useMemo((): TodayQueueTask[] => tasks.map((task) => ({
    ...task,
    recommendedAt: ("recommendedAt" in task && (task as TodayQueueTask).recommendedAt != null)
      ? (task as TodayQueueTask).recommendedAt
      : task.retest?.recommendedAt ?? null,
  })), [tasks]);
  const groups = useMemo(
    () => groupTodayQueue(queueTasks, plan?.blocks ?? [], nowTick, timeZone),
    [queueTasks, plan?.blocks, nowTick, timeZone],
  );
  useEffect(() => {
    if (loadState !== "ready" || !onSelect) return;
    const next = selectTodayTask(groups, { selectedId, focusTaskId, doneView });
    if (next) onSelect({ ...next, reason: plan?.blocks.find((block) => block.taskId === next.id)?.reason }, "focus");
    else onClearSelection?.();
  }, [doneView, focusTaskId, groups, loadState, onClearSelection, onSelect, plan, selectedId]);
  const remaining = [...groups.confirmed, ...groups.dueRetests, ...groups.overdue, ...groups.other];
  const done = groups.done;
  const completedCount = done.filter((task) => task.status === "done").length;
  const skippedCount = done.length - completedCount;
  const selectablePending = groups.confirmed.length + groups.dueRetests.length + groups.overdue.length + groups.other.length;
  const upcomingHint = upcomingRetestHint(queueTasks, nowTick, timeZone, groups.upcomingRetestCount);
  return <TaskPlanningTimeZoneContext.Provider value={timeZone}><section className="flex min-h-full flex-col bg-surface" aria-label="今日计划">
    {adaptivePlanning ? <AutonomySwitcher api={api} onChanged={() => { setCoachSettingsRevision(value => value + 1); void refresh({ refreshSuggestions: true }); }} /> : null}
    <div className="border-b border-line/70 px-5 pb-3 pt-4"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold text-text">今天还要做</h2><button type="button" aria-label="安排时间" aria-expanded={planning} aria-controls="opening-plan-editor" className={secondaryButtonClass} disabled={!plan || planState !== "ready" || loadState !== "ready"} onClick={() => setPlanning(!planning)}><CalendarDays size={15} aria-hidden /></button></div><p className="mt-1 text-xs text-text-3">{loadState === "ready" ? `当前可选 ${remaining.length} 项 · 预计 ${remaining.reduce((sum, task) => sum + task.minutes, 0)} 分钟` : loadState === "error" ? "任务读取失败" : "正在读取任务"}</p></div>
    {loadState === "ready" ? <QuickAddTask api={api} disabled={pending} onAdded={() => { void refresh(); }} /> : null}
    {planning ? <div id="opening-plan-editor" className="space-y-3 border-b border-line bg-surface px-4 py-4">
      <h3 className="text-xs font-semibold text-text">安排可用时间</h3>
      <label className="block text-xs text-text-2">开始<input aria-label="可用时间开始" type="datetime-local" value={freeStart} onChange={(event) => setFreeStart(event.target.value)} className={`${inputClass} mt-1`} disabled={pending} /></label>
      <label className="block text-xs text-text-2">结束<input aria-label="可用时间结束" type="datetime-local" value={freeEnd} onChange={(event) => setFreeEnd(event.target.value)} className={`${inputClass} mt-1`} disabled={pending} /></label>
      <button type="button" onClick={() => void propose()} disabled={pending || Boolean(draft) || !plan || planState !== "ready" || loadState !== "ready" || !canProposePlan({ start: freeStart, end: freeEnd })} className={`${buttonClass} w-full`}>{pending ? "正在处理…" : "生成计划"}</button>
      {plan?.blocks.length ? <details><summary className="min-h-10 cursor-pointer py-2 text-xs text-text-2">已确认安排 · {plan.blocks.length} 个时间块</summary><ul className="space-y-2 text-xs leading-5 text-text-2">{plan.blocks.map((block) => <li key={`${block.taskId}-${block.start}`}><span className="font-medium text-text">{tasks.find((task) => task.id === block.taskId)?.title ?? "学习任务"}</span><p>{timeLabel(block.start)}–{timeLabel(block.end)}</p><p>{block.reason}</p></li>)}</ul></details> : null}
      {draft ? <div className="space-y-3 border-t border-line pt-3"><p className="text-xs font-semibold text-text">计划变更预览</p><p className="text-xs leading-5 text-text-2">当前 {plan?.blocks.length ?? 0} 个时间块 → 草案 {draft.blocks.length} 个时间块；未安排 {draft.unscheduledTaskIds.length} 项。</p>
        <ul className="space-y-2 text-xs leading-5 text-text-2">{draft.blocks.map((block) => <li key={`${block.taskId}-${block.start}`}><span className="font-medium text-text">{tasks.find((task) => task.id === block.taskId)?.title ?? "学习任务"}</span><p>{timeLabel(block.start)}–{timeLabel(block.end)}</p><p>{block.reason}</p></li>)}</ul>
        {draftIsStale ? <p className="text-xs leading-5 text-warn">计划或日期已变化。请取消当前建议，重新生成后确认。</p> : null}
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void accept()} disabled={loadState !== "ready" || planState !== "ready" || !canAcceptPlan({ pending, stale: draftIsStale })} className={buttonClass}>确认变更</button><button type="button" onClick={() => void reject()} disabled={pending} className={secondaryButtonClass}>取消草案</button></div>
      </div> : null}
    </div> : null}
    <div className="mx-4 my-3 flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="队列筛选">{[false, true].map((completed) => <button key={String(completed)} type="button" aria-pressed={doneView === completed} onClick={() => { setDoneView(completed); setAll(false); }} className={`min-h-10 flex-1 rounded-md px-2 text-xs font-medium transition-[color,background-color,box-shadow] duration-200 ease-out-expo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 motion-reduce:transition-none md:min-h-8 ${doneView === completed ? "bg-surface text-text shadow-sm shadow-zinc-900/10" : "text-text-2 hover:text-text"}`}>{completed ? `已结束 ${done.length}` : `待办 ${selectablePending}`}</button>)}</div>
    {error ? <div className="mx-3 mb-3 border border-danger/20 bg-danger/10 p-3"><p className="text-xs leading-5 text-danger" role="alert">{error}</p><button type="button" onClick={() => void refresh()} disabled={loadState === "loading" || pending} className={`${secondaryButtonClass} mt-2`}>重新读取</button></div> : null}
    {planWarning ? <div className="mx-4 mb-3 rounded-lg border border-warn/20 bg-warn-soft p-3"><p className="text-xs leading-5 text-warn" role="status">{planWarning}</p><button type="button" className={`${secondaryButtonClass} mt-2`} disabled={pending || loadState === "loading"} onClick={() => void refresh()}>重试读取安排</button></div> : null}
    {doneView && loadState === "ready" ? <p className="mx-4 mb-2 text-xs text-text-3">已完成 {completedCount} 项 · 已跳过 {skippedCount} 项；跳过不计为完成。</p> : null}
    {!doneView && loadState === "ready" && upcomingHint ? <p className="mx-4 mb-2 text-xs leading-5 text-text-3" role="status">{upcomingHint}</p> : null}
    {doneView
      ? <TodayTaskList tasks={done} state={loadState} focusTaskId={undefined} selectedId={selectedId} onSelect={onSelect} plan={plan} showAll={all} doneView api={api} />
      : <TodayGroupedQueue groups={groups} state={loadState} focusTaskId={focusTaskId} selectedId={selectedId} onSelect={onSelect} plan={plan} api={api} />}
    {doneView && done.length > 3 ? <button type="button" className={`${secondaryButtonClass} mx-3 mt-2`} aria-expanded={all} onClick={() => setAll(!all)}>{all ? "收起列表" : `查看全部 ${done.length} 项`}<ChevronDown size={12} aria-hidden /></button> : null}
    <div id="action-digest" tabIndex={-1} className="scroll-mt-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
      {hasLoadedTasks ? <RetestProposals api={api} onChanged={refresh} /> : null}
      {hasLoadedTasks ? <ActionDigest api={api} onChanged={refresh} onAdjust={() => setPlanning(true)} /> : null}
    </div>
    {hasLoadedTasks && plan ? <fieldset disabled={pending || loadState !== "ready" || planState !== "ready"} className="min-w-0 disabled:opacity-60">
      {adaptivePlanning && plan.replanOffer?.offer ? <LocalReplanCard key={`${date}:${plan.acceptedVersion}`} api={api} date={date} acceptedVersion={plan.acceptedVersion} blocks={plan.blocks} tasks={tasks} reason={plan.replanOffer.reason} dismissalKey={plan.replanOffer.dismissalKey} timeZone={timeZone} onChanged={refresh} /> : null}
      {adaptivePlanning ? <CoachPlanControl date={date} draft={plan.dailyDraft ?? null} api={api} onChanged={refresh} settingsRevision={coachSettingsRevision} /> : null}
      <DailyDraftCard key={date} api={api} date={date} acceptedVersion={plan.acceptedVersion} dailyDraft={plan.dailyDraft ?? null} dailyDraftSkippedReason={plan.dailyDraftSkippedReason ?? null} unplannedPendingCount={plan.unplannedPendingCount} tasks={tasks} onChanged={refresh} adaptivePlanning={adaptivePlanning} hasNewerSuggestion={plan.hasNewerSuggestion} onRefreshSuggestions={() => refresh({ refreshSuggestions: true })} />
      <details className="mx-4 mt-4 rounded-xl border border-line bg-surface"><summary className="min-h-11 cursor-pointer px-3 py-3 text-xs font-medium text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">今日安排与进度</summary><TodayPlanOverview tasks={tasks} plan={plan} onArrange={() => setPlanning(true)} /></details>
    </fieldset> : null}
    {hasLoadedTasks ? <TodayStudyTools key={date} disabled={pending || loadState !== "ready" || planState !== "ready"} api={api} date={date} plan={plan} tasks={tasks} onChanged={refresh} /> : null}
    <div className="mt-auto px-4 pb-4 pt-6" />
  </section></TaskPlanningTimeZoneContext.Provider>;
}

export function TodayGroupedQueue({ groups, state, focusTaskId, selectedId, onSelect, plan, api }: {
  groups: ReturnType<typeof groupTodayQueue>;
  state: TaskLoadState;
  focusTaskId?: string;
  selectedId?: string;
  onSelect?: (task: StudyTask, source?: SelectionSource) => void;
  plan?: Awaited<ReturnType<OpeningApi["getToday"]>> | null;
  api?: Pick<OpeningApi, "updateTaskStatus"> & Partial<Pick<OpeningApi, "deferTask">>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (state === "loading") return <p className="px-4 py-5 text-xs text-text-3" role="status">正在加载任务…</p>;
  if (state === "error") return <p className="px-4 py-5 text-xs text-danger">任务暂时无法读取，请重试。</p>;
  const total = groups.confirmed.length + groups.dueRetests.length + groups.overdue.length + groups.other.length;
  const visible = expanded ? groups : previewTodayQueue(groups, focusTaskId ?? selectedId);
  const sections = [
    { key: "confirmed" as const, tasks: visible.confirmed },
    { key: "dueRetests" as const, tasks: visible.dueRetests },
    { key: "overdue" as const, tasks: visible.overdue },
    { key: "other" as const, tasks: visible.other },
  ].filter((section) => section.tasks.length > 0);
  if (!sections.length && !groups.deferred.length) {
    return <div className="px-4 py-6"><p className="text-sm text-text-2">暂无待完成任务。</p><p className="mt-2 text-xs leading-6 text-text-3">继续探索或整理笔记，无需先创建任务。也可用上方快速添加。</p></div>;
  }
  return <div className="space-y-3" aria-label="分组学习队列">
    {groups.deferred.length ? <details className="mx-4 rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-xs text-text-2">已推迟 {groups.deferred.length} 项</summary>
      <ul className="mt-3 space-y-3">{groups.deferred.map(task => <li key={task.id}>
        <p className="mb-2 text-xs text-text-2">{task.title}</p>
        {api ? <TaskStatusControl task={task} api={api} disabled={false} /> : null}
      </li>)}</ul>
    </details> : null}
    {sections.map((section) => (
      <div key={section.key}>
        <h3 className="px-4 pb-1 text-xs font-semibold text-text-3">{QUEUE_GROUP_LABELS[section.key]} · {groups[section.key].length}</h3>
        <TodayTaskList tasks={section.tasks} state="ready" focusTaskId={focusTaskId} selectedId={selectedId} onSelect={onSelect} plan={plan} showAll doneView={false} api={api} />
      </div>
    ))}
    {total > 5 ? <button type="button" className={`${secondaryButtonClass} mx-4`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起任务" : `查看其余 ${total - 5} 项任务`}<ChevronDown size={14} aria-hidden="true" /></button> : null}
  </div>;
}

export function TodayTaskList({ tasks, state, focusTaskId, selectedId, onSelect, plan, showAll = false, doneView = false, api }: {
  tasks: TodayTasks; state: TaskLoadState; focusTaskId?: string; selectedId?: string; onSelect?: (task: StudyTask, source?: SelectionSource) => void;
  plan?: Awaited<ReturnType<OpeningApi["getToday"]>> | null; showAll?: boolean; doneView?: boolean;
  api?: Pick<OpeningApi, "updateTaskStatus"> & Partial<Pick<OpeningApi, "deferTask">>;
}) {
  const focusRef = useCallback((element: HTMLLIElement | null) => focusTodayTask(element, focusTaskId), [focusTaskId]);
  if (state === "loading") return <p className="px-4 py-5 text-xs text-text-3" role="status">正在加载任务…</p>;
  if (state === "error") return <p className="px-4 py-5 text-xs text-danger">任务暂时无法读取，请重试。</p>;
  const visibleTasks = doneView ? tasks.slice(0, showAll ? undefined : 3) : showAll ? [...tasks.filter((task) => task.id === focusTaskId), ...tasks.filter((task) => task.status === "pending" && task.id !== focusTaskId)] : visibleTodayTasks(tasks, focusTaskId);
  if (!visibleTasks.length) return <div className="px-4 py-6"><p className="text-sm text-text-2">{doneView ? "尚无已结束任务。" : "暂无待完成任务。"}</p><p className="mt-2 text-xs leading-6 text-text-3">继续探索或整理笔记，无需先创建任务。</p></div>;
  return <ul className="border-y border-line/60" aria-label="学习任务列表">{visibleTasks.map((task) => {
    const block = plan?.blocks.find((entry) => entry.taskId === task.id), active = task.id === selectedId;
    const showStatus = !doneView && task.status === "pending" && api;
    return <li key={task.id} id={`task-${task.id}`} ref={task.id === focusTaskId ? focusRef : undefined} tabIndex={task.id === focusTaskId ? -1 : undefined} className="scroll-mt-6 border-b border-line/50 last:border-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/50">
      <div className="flex flex-col" data-today-task-row="true">
        <button type="button" aria-pressed={active} onClick={() => onSelect?.({ ...task, reason: block?.reason }, "user")} className={`group flex min-h-[80px] w-full items-start gap-3 border-l-2 px-4 py-3.5 text-left transition-[color,background-color,border-color,transform] duration-200 ease-out-expo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 ${active ? "border-accent bg-gradient-to-r from-accent-soft/80 to-transparent" : "border-transparent hover:border-line hover:bg-surface-2"}`}>
          {task.status === "done" ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden /> : <Circle size={16} className={`mt-0.5 shrink-0 transition-colors duration-200 ${active ? "text-accent" : "text-text-3 group-hover:text-text-3"}`} aria-hidden />}
          <span className="min-w-0 flex-1"><span className="line-clamp-2 break-words text-[13px] font-medium leading-6 text-text">{task.title}</span><span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-3"><Clock3 size={12} aria-hidden />{task.minutes} 分钟<span aria-hidden>/</span>{task.status === "done" ? "已完成" : task.status === "skipped" ? "已跳过" : block ? `${timeLabel(block.start)}–${timeLabel(block.end)}` : "待安排"}</span></span>
          {active ? <ArrowRight size={14} className="mt-1 shrink-0 text-accent motion-safe:animate-enter" aria-hidden /> : null}
        </button>
        {showStatus ? (
          <div className="border-l-2 border-transparent px-4 pb-3" data-today-task-status="true">
            <TaskRowActions task={task} />
            <TaskStatusControl
              key={`${task.id}:${task.version ?? "unknown"}`}
              task={task}
              api={api}
              disabled={false}
              retestOrigin={isRetestOriginTask(task)}
            />
          </div>
        ) : null}
      </div>
    </li>;
  })}</ul>;
}
