import type { ReactNode } from "react";
import type { LearningResume, TaskItem } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { secondaryButtonClass, ui } from "../design/ui";
import type { TodayCourse, TodayResumeState } from "./today-read";
import { ContinueCard } from "./continue-card";

type TodayPlan = Awaited<ReturnType<OpeningApi["getToday"]>>;

export function summarizeTodayPlan(tasks: TaskItem[], plan: TodayPlan) {
  const plannedIds = new Set(plan.blocks.map((block) => block.taskId));
  const plannedTasks = tasks.filter((task) => plannedIds.has(task.id));
  const pendingIds = new Set(plannedTasks.filter((task) => task.status === "pending").map((task) => task.id));
  return {
    total: plannedIds.size,
    done: plannedTasks.filter((task) => task.status === "done").length,
    pending: pendingIds.size,
    pendingMinutes: Math.round(plan.blocks.filter((block) => pendingIds.has(block.taskId))
      .reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)) / 60_000, 0)),
    skipped: plannedTasks.filter((task) => task.status === "skipped").length,
    unavailable: plannedIds.size - plannedTasks.length,
  };
}

export function TodayPlanOverview({ tasks, plan, onArrange }: { tasks: TaskItem[]; plan: TodayPlan; onArrange: () => void }) {
  const summary = summarizeTodayPlan(tasks, plan);
  return <section className="border-y border-line/80 bg-gradient-to-b from-surface to-surface-2/50 px-5 py-4" aria-labelledby="today-plan-overview-heading">
    <h3 id="today-plan-overview-heading" className="text-sm font-semibold text-text">今日已确认计划</h3>
    {!plan.acceptedVersion ? <><p className="mt-2 text-sm leading-6 text-text-3">还未确认今天的时间安排。可以直接选任务学习。</p><button type="button" onClick={onArrange} className={`${secondaryButtonClass} mt-3`}>安排可用时间</button></>
      : !summary.total ? <p className="mt-2 text-sm leading-6 text-text-3">今天已确认的计划没有学习任务,可从学习队列继续。</p>
        : <><dl className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-surface px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5"><dt className="text-xs text-text-3">计划内已完成</dt><dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-text"><span>{summary.done}/{summary.total} 项</span></dd></div>
          <div className="rounded-lg bg-surface px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5"><dt className="text-xs text-text-3">待做</dt><dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-accent">{summary.pending}<span className="ml-1 text-base font-normal text-text-3">项</span></dd></div>
          <div className="rounded-lg bg-surface px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5"><dt className="text-xs text-text-3">待做预计</dt><dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-text">{summary.pendingMinutes}<span className="ml-1 text-base font-normal text-text-3">分</span></dd></div>
        </dl><details className="mt-3 text-xs leading-6 text-text-3"><summary className="cursor-pointer py-1.5 hover:text-text-2 focus-visible:ring-2 focus-visible:ring-accent/50">统计范围与依据</summary><p className="pt-1">{plan.date} 已确认计划中的任务当前状态；完成时间可能早于今天。预计时间来自已确认时间块,不是实际学习时长。</p>{summary.skipped ? <p className="pt-1">{summary.skipped} 项已跳过。</p> : null}{summary.unavailable ? <p className="pt-1">{summary.unavailable} 项暂不在当前队列中,未推断其完成状态。</p> : null}</details></>}
  </section>;
}

export function TodayLearningContext({
  item,
  activity,
  primaryAction,
  secondaryAction,
  onShowActions,
  resume,
  courseTitle,
  course,
  timeZone,
}: {
  item?: TodayResumeState["continueItem"];
  activity?: { title: string; courseId: string | null; id?: string; contentVersion?: number } | null;
  resume?: LearningResume | null;
  courseTitle?: string | null;
  course?: TodayCourse | null;
  timeZone?: string;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
  onShowActions?: () => void;
}) {
  return <div className="min-w-0 px-4 py-5 sm:px-5">
    <ContinueCard item={item} activity={activity} courseTitle={courseTitle} course={course} timeZone={timeZone} resume={resume} primaryAction={primaryAction} secondaryAction={secondaryAction} />
    <nav aria-label="学习闭环快捷入口" className="mt-2 flex flex-wrap gap-1" data-today-loop-links="true">
      {onShowActions ? <button type="button" className={ui.quiet} onClick={onShowActions}>优先行动</button> : <a href="#action-digest" className={ui.quiet}>优先行动</a>}
    </nav>
  </div>;
}
