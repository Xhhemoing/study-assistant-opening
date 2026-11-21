"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { TaskItem } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { createOpeningCardsClient } from "../cards/cards-client";
import { groupReviewTasks } from "../review/review-queue";
import { ui } from "../design/ui";
import { localDateKey } from "./today-view";
import { summarizeTodayPlan } from "./today-overview";
import { groupTodayQueue } from "./today-queue-groups";
import { courseStudyHref } from "../courses/course-study-model";
import { TaskRowActions } from "./task-row-actions";
import { TaskPlanningTimeZoneContext, TaskQueueRefreshContext, TaskStatusControl } from "./task-status-control";

type Plan = Awaited<ReturnType<OpeningApi["getToday"]>>;
type Progress = {
  tasks: TaskItem[] | null;
  plan: { done: number; total: number } | null;
  decision: { plan: Plan; tasks: TaskItem[] } | null;
  reviews: number | null;
  failed: boolean;
};

/** Confirmed task progress, not inferred study time or mastery. These reads never accept a plan. */
export function TodayProgress({ api, timeZone, reloadToken, decision }: {
  api: Pick<OpeningApi, "listTasks" | "getToday"> & Partial<Pick<OpeningApi, "updateTaskStatus" | "deferTask">>; timeZone: string; reloadToken: number;
  decision?: (plan: Plan, tasks: TaskItem[]) => ReactNode;
}) {
  const refreshQueue = useContext(TaskQueueRefreshContext);
  const cards = useMemo(() => createOpeningCardsClient(), []);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const now = new Date();
    void Promise.allSettled([api.listTasks(), api.getToday(localDateKey(now, timeZone)), cards.listDue("auto")]).then(([tasks, plan, due]) => {
      if (!active) return;
      const groups = tasks.status === "fulfilled" ? groupTodayQueue(tasks.value.tasks, plan.status === "fulfilled" ? plan.value.blocks : [], now, timeZone) : null;
      setProgress({
        tasks: groups ? [...groups.confirmed, ...groups.dueRetests, ...groups.overdue, ...groups.other] : null,
        plan: tasks.status === "fulfilled" && plan.status === "fulfilled"
          ? summarizeTodayPlan(tasks.value.tasks, plan.value) : null,
        decision: plan.status === "fulfilled" && tasks.status === "fulfilled" ? { plan: plan.value, tasks: tasks.value.tasks } : null,
        reviews: tasks.status === "fulfilled" && due.status === "fulfilled"
          ? groupReviewTasks(tasks.value.tasks, now.getTime()).ready.length + due.value.length : null,
        failed: [tasks, plan, due].some(result => result.status === "rejected"),
      });
    });
    const onFocus = () => setRevision(value => value + 1);
    window.addEventListener("focus", onFocus);
    return () => { active = false; window.removeEventListener("focus", onFocus); };
  }, [api, cards, timeZone, reloadToken, revision]);

  const reviewTasks = groupReviewTasks(progress?.tasks ?? [], Date.now());
  const taskRows = (tasks: TaskItem[]) => <ul className="divide-y divide-line" aria-label="今日待办">{tasks.map(task => {
    const retest = task.retest ? reviewTasks.ready.find(item => item.task.id === task.id) : null;
    const href = task.retest ? retest?.href : task.courseId ? `${courseStudyHref(task.courseId)}?task=${encodeURIComponent(task.id)}` : `/opening/settings/planning?task=${encodeURIComponent(task.id)}`;
    return <li key={task.id} className="space-y-2 py-3.5 first:pt-2.5 last:pb-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-text">{task.title}</p>
        <p className="text-xs tabular-nums text-text-3">{task.retest ? "到期补测" : ""}{task.estimateMinutes != null ? `${task.retest ? " · " : ""}预计 ${task.estimateMinutes} 分钟` : ""}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {href ? <Link href={href} className={ui.quiet}>{task.retest ? "打开补测" : "打开任务"}</Link> : <p className="text-xs text-warn">补测关联暂时不可用，请到复习页核对。</p>}
        <TaskRowActions task={task} />
      </div>
      {api.updateTaskStatus ? <TaskStatusControl key={`${task.id}:${task.version ?? "unknown"}`} task={task} api={{ updateTaskStatus: api.updateTaskStatus, deferTask: api.deferTask }} disabled={false} /> : null}
    </li>;
  })}</ul>;
  return <TaskPlanningTimeZoneContext.Provider value={timeZone}><TaskQueueRefreshContext.Provider value={() => { setRevision(value => value + 1); refreshQueue?.(); }}>
    {progress?.decision ? decision?.(progress.decision.plan, progress.decision.tasks) : null}
    <section aria-label="今天的进度" className="rounded-card border border-line bg-surface px-4 py-4 shadow-card group-data-[focus=true]/workspace:hidden sm:px-5">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold text-text">今天的进度</h2>
        {!progress ? <p role="status" className="mt-1.5 text-sm text-text-2">正在查看…</p>
          : progress.plan?.total ? <><p className="mt-1.5 text-sm tabular-nums text-text-2">今日计划已完成 {progress.plan.done}/{progress.plan.total} 项</p><progress aria-label="今日计划完成进度" value={progress.plan.done} max={progress.plan.total} className="well-recessed mt-2 h-2 w-48 overflow-hidden rounded-full accent-accent [&::-webkit-progress-bar]:bg-transparent [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent" /></>
            : progress.plan ? <p className="mt-1.5 text-sm text-text-2">从一道练习开始，慢慢积累。</p> : null}
      </div>
      <Link href="/opening/review" className={`${ui.secondary} tabular-nums`}>复习{progress?.reviews != null ? ` · ${progress.reviews} 项` : ""}</Link>
    </div>
    {progress?.tasks?.length ? <div className="mt-4 border-t border-line pt-3">
      <h3 className="text-xs font-medium text-text-2">今天还要做</h3>
      {taskRows(progress.tasks.slice(0, 3))}
      {progress.tasks.length > 3 ? <details className="group border-t border-line pt-1"><summary className="flex min-h-10 cursor-pointer list-none items-center justify-between py-2 text-xs tabular-nums text-text-2 transition-colors hover:text-text [&::-webkit-details-marker]:hidden"><span>其余 {progress.tasks.length - 3} 项待办</span><ChevronDown size={14} aria-hidden="true" className="text-text-3 transition-transform duration-200 ease-out-strong group-open:rotate-180" /></summary>{taskRows(progress.tasks.slice(3))}</details> : null}
    </div> : null}
    {progress?.failed ? <p role="status" className="mt-3 text-xs text-text-2">部分进度还没加载好。<button type="button" className={ui.quiet} onClick={() => setRevision(value => value + 1)}>再试一次</button></p> : null}
  </section></TaskQueueRefreshContext.Provider></TaskPlanningTimeZoneContext.Provider>;
}
