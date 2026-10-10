import Link from "next/link";
import type { TaskItem } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { secondaryButtonClass, ui } from "../design/ui";
import type { TodayResumeState } from "./today-read";

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
  return <section className="border-y border-zinc-200/80 bg-gradient-to-b from-white to-zinc-50/50 px-5 py-4" aria-labelledby="today-plan-overview-heading">
    <h3 id="today-plan-overview-heading" className="text-sm font-semibold text-zinc-900">今日已确认计划</h3>
    {!plan.acceptedVersion ? <><p className="mt-2 text-sm leading-6 text-zinc-500">还未确认今天的时间安排。可以直接选任务学习。</p><button type="button" onClick={onArrange} className={`${secondaryButtonClass} mt-3`}>安排可用时间</button></>
      : !summary.total ? <p className="mt-2 text-sm leading-6 text-zinc-500">今天已确认的计划没有学习任务,可从下方队列继续。</p>
        : <><dl className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-lg bg-white px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5"><dt className="text-xs text-zinc-500">计划内已完成</dt><dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900"><span>{summary.done}/{summary.total} 项</span></dd></div>
          <div className="rounded-lg bg-white px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5"><dt className="text-xs text-zinc-500">待做</dt><dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-emerald-700">{summary.pending}<span className="ml-1 text-base font-normal text-zinc-400">项</span></dd></div>
          <div className="rounded-lg bg-white px-3 py-2.5 shadow-xs ring-1 ring-zinc-900/5"><dt className="text-xs text-zinc-500">待做预计</dt><dd className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-zinc-900">{summary.pendingMinutes}<span className="ml-1 text-base font-normal text-zinc-400">分</span></dd></div>
        </dl><details className="mt-3 text-xs leading-6 text-zinc-500"><summary className="cursor-pointer py-1.5 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-emerald-600/50">统计范围与依据</summary><p className="pt-1">{plan.date} 已确认计划中的任务当前状态；完成时间可能早于今天。预计时间来自已确认时间块,不是实际学习时长。</p>{summary.skipped ? <p className="pt-1">{summary.skipped} 项已跳过。</p> : null}{summary.unavailable ? <p className="pt-1">{summary.unavailable} 项暂不在当前队列中,未推断其完成状态。</p> : null}</details></>}
  </section>;
}

export function TodayLearningContext({ item }: { item?: TodayResumeState["continueItem"] }) {
  const sourceCount = Object.keys(item?.sourceVersions ?? {}).length;
  const courseHref = item?.courseId ? `/opening/courses/${encodeURIComponent(item.courseId)}` : "/opening/courses";
  return <div className="min-w-0 border-b border-zinc-200 px-4 py-2 sm:px-5">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-zinc-700">{item ? `上次学习：${item.title}` : "从一个问题、一次练习或一篇笔记开始"}</p>
        {item ? <p className="mt-1 text-[11px] text-zinc-500">{item.currentPage ? `上次读到第 ${item.currentPage} 页` : "可继续上次保存的对话"}{sourceCount ? ` · 可恢复 ${sourceCount} 份材料` : ""}</p> : null}
        {item?.manualSourceCount ? <p className="mt-1 text-[11px] leading-5 text-zinc-500">{item.manualSourceCount} 份材料仅供手工阅读，已停止供 AI 使用；可在材料页查看。</p> : null}
      </div>
      <nav aria-label="其他学习方式" className="flex shrink-0 flex-wrap gap-1">
        <Link href={courseHref} className={ui.quiet}>{item?.courseId ? "回到关联课程" : "课程与自主练习"}</Link>
      </nav>
    </div>
    <nav aria-label="学习闭环快捷入口" className="mt-2 flex flex-wrap gap-1" data-today-loop-links="true">
      <Link href="/opening/cards" className={ui.quiet}>卡片</Link>
      <Link href="/opening/review" className={ui.quiet}>待确认</Link>
      <Link href="/opening/settings/connections" className={ui.quiet}>连接</Link>
      <a href="#action-digest" className={ui.quiet}>优先行动</a>
      <Link href={courseHref} className={ui.quiet} title="课程知识 / 材料在课程页">课程知识 / 材料在课程页</Link>
    </nav>
  </div>;
}
