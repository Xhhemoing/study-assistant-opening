"use client";
import Link from "next/link";
import { ArrowDownLeft, Clock3 } from "lucide-react";
import type { OpeningApi } from "../client/api";
import { TaskReminder } from "./task-reminder";
import { secondaryButtonClass } from "../design/ui";
import { isDueRetestSelection, retestPracticeHref } from "../learning/retest-attempt";
import { taskPrompt, type StudyTask } from "../planning/study-task";
import { isRetestOriginTask, TaskStatusControl } from "../planning/task-status-control";
export function TaskContext({ task, api, disabled, onPrompt }: { task: StudyTask; api: Pick<OpeningApi, "requestTaskReminder" | "updateTaskStatus">; disabled: boolean; onPrompt: (value: string) => void }) {
  const dueRetest = isDueRetestSelection(task);
  return <section aria-label="当前任务上下文" className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-1 sm:px-5">
    <div className="flex items-center gap-3 text-[11px] text-zinc-500"><span className="flex items-center gap-1.5"><Clock3 size={12} aria-hidden />{task.minutes} 分钟{task.status === "done" ? " · 回看" : task.status === "skipped" ? " · 已跳过" : ""}</span>
      <details className="relative"><summary className="w-fit cursor-pointer rounded py-2 focus-visible:ring-2 focus-visible:ring-emerald-700">安排依据</summary><p className="absolute left-0 top-full z-10 mt-1 w-56 rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-6 text-zinc-600">{task.reason || "这是一项已保存的任务，尚无已确认的时间安排。可以先思考，或在队列中安排时间。"}</p></details>
    </div>
    {dueRetest && task.retest ? <Link className={secondaryButtonClass} href={retestPracticeHref(task.retest.courseId, task.retest.candidateId)}>开始补测</Link> : null}
    <TaskStatusControl key={`${task.id}:${"version" in task ? task.version ?? "unknown" : "unknown"}`} task={task} api={api} disabled={disabled} retestOrigin={isRetestOriginTask(task)} />
    <button className={secondaryButtonClass} type="button" disabled={disabled} onClick={() => onPrompt(taskPrompt(task))}><ArrowDownLeft size={12} aria-hidden />带入输入</button>
    <TaskReminder key={`${task.id}:${"version" in task ? task.version : "unknown"}`} task={task} api={api} disabled={disabled} />
  </section>;
}
