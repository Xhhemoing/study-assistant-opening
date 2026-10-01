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
  return <section className="border-b border-zinc-200 px-4 py-3" aria-labelledby="today-plan-overview-heading">
    <h3 id="today-plan-overview-heading" className="text-xs font-semibold text-zinc-800">今日已确认计划</h3>
    {!plan.acceptedVersion ? <><p className="mt-2 text-xs leading-5 text-zinc-500">还未确认今天的时间安排。可以直接选任务学习。</p><button type="button" onClick={onArrange} className={`${secondaryButtonClass} mt-2`}>安排可用时间</button></>
      : !summary.total ? <p className="mt-2 text-xs leading-5 text-zinc-500">今天已确认的计划没有学习任务，可从下方队列继续。</p>
        : <><dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div><dt className="text-zinc-500">计划内已完成</dt><dd className="mt-1 font-semibold tabular-nums text-zinc-800">{summary.done}/{summary.total} 项</dd></div>
          <div><dt className="text-zinc-500">待做</dt><dd className="mt-1 font-semibold tabular-nums text-zinc-800">{summary.pending} 项</dd></div>
          <div><dt className="text-zinc-500">待做预计</dt><dd className="mt-1 font-semibold tabular-nums text-zinc-800">{summary.pendingMinutes} 分钟</dd></div>
        </dl><details className="mt-2 text-[11px] leading-5 text-zinc-500"><summary className="cursor-pointer py-1 focus-visible:ring-2 focus-visible:ring-emerald-700">统计范围与依据</summary><p>{plan.date} 已确认计划中的任务当前状态；完成时间可能早于今天。预计时间来自已确认时间块，不是实际学习时长。</p>{summary.skipped ? <p>{summary.skipped} 项已跳过。</p> : null}{summary.unavailable ? <p>{summary.unavailable} 项暂不在当前队列中，未推断其完成状态。</p> : null}</details></>}
  </section>;
}

export function TodayLearningContext({ item }: { item?: TodayResumeState["continueItem"] }) {
  const sourceCount = Object.keys(item?.sourceVersions ?? {}).length;
  return <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-zinc-200 px-4 py-2 sm:px-5">
    <div className="min-w-0 flex-1">
      <p className="truncate text-xs text-zinc-700">{item ? `上次学习：${item.title}` : "从一个问题、一次练习或一篇笔记开始"}</p>
      {item ? <p className="mt-1 text-[11px] text-zinc-500">{item.currentPage ? `上次读到第 ${item.currentPage} 页` : "可继续上次保存的对话"}{sourceCount ? ` · 可恢复 ${sourceCount} 份材料` : ""}</p> : null}
      {item?.manualSourceCount ? <p className="mt-1 text-[11px] leading-5 text-zinc-500">{item.manualSourceCount} 份材料仅供手工阅读，已停止供 AI 使用；可在材料页查看。</p> : null}
    </div>
    <nav aria-label="其他学习方式" className="flex shrink-0 flex-wrap gap-1">
      <Link href={item?.courseId ? `/opening/courses/${encodeURIComponent(item.courseId)}` : "/opening/courses"} className={ui.quiet}>{item?.courseId ? "回到关联课程" : "课程与自主练习"}</Link>
      <Link href="/library/new" className={ui.quiet}>写笔记</Link>
    </nav>
  </div>;
}
