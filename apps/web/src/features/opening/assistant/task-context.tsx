"use client";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { ArrowDownLeft, Clock3 } from "lucide-react";
import type { OpeningApi } from "../client/api";
import { TaskReminder } from "./task-reminder";
import { secondaryButtonClass } from "../design/ui";
import { isDueRetestSelection, retestPracticeHref } from "../learning/retest-attempt";
import { taskPrompt, type StudyTask } from "../planning/study-task";
import { isRetestOriginTask, TaskStatusControl } from "../planning/task-status-control";
export function TaskContext({ task, api, disabled, onPrompt }: { task: StudyTask; api: Pick<OpeningApi, "requestTaskReminder" | "updateTaskStatus">; disabled: boolean; onPrompt: (value: string) => void }) {
  const dueRetest = isDueRetestSelection(task);
  return <section aria-label="当前任务上下文" className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-4 py-1 sm:px-5">
    <div className="flex items-center gap-3 text-xs text-text-3"><span className="flex items-center gap-1.5"><Clock3 size={12} aria-hidden />{task.minutes} 分钟{task.status === "done" ? " · 回看" : task.status === "skipped" ? " · 已跳过" : ""}</span>
      <details className="relative"><summary className="min-h-11 w-fit cursor-pointer rounded py-2 focus-visible:ring-2 focus-visible:ring-accent">安排依据</summary><p className="absolute left-0 top-full z-10 mt-1 w-56 rounded-lg border border-line bg-surface p-3 text-xs leading-6 text-text-2">{task.reason || "这是一项已保存的任务，尚无已确认的时间安排。可以先思考，或在队列中安排时间。"}</p></details>
    </div>
    {dueRetest && task.retest ? <Link className={secondaryButtonClass} href={retestPracticeHref(task.retest.courseId, task.retest.candidateId)}>开始补测</Link> : null}
    <TaskStatusControl key={`${task.id}:${"version" in task ? task.version ?? "unknown" : "unknown"}`} task={task} api={api} disabled={disabled} retestOrigin={isRetestOriginTask(task)} />
    <button className={secondaryButtonClass} type="button" disabled={disabled} onClick={() => onPrompt(taskPrompt(task))}><ArrowDownLeft size={12} aria-hidden />带入输入</button>
    <TaskReminder key={`${task.id}:${"version" in task ? task.version : "unknown"}`} task={task} api={api} disabled={disabled} />
  </section>;
}
