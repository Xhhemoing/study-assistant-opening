"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { TaskItem, TeachingActivity, TeachingActivitySummary } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { TaskQueueRefreshContext, TaskStatusControl } from "../planning/task-status-control";
import { createTeachingActivityClient } from "./activity-client";
import { ui } from "../design/ui";

export function ActivitySummaryContent({ summary, task, api, onReread, next }: {
  summary: TeachingActivitySummary;
  task: TaskItem | null;
  api: Pick<OpeningApi, "updateTaskStatus">;
  onReread: () => void;
  /** 「再学一节」; absent where the page cannot open the next section. */
  next?: { start: () => void; pending: boolean; error: string };
}) {
  return <section className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4" aria-label="本次学习小结">
    <h3 className="text-sm font-semibold text-zinc-900">本次学习已结束</h3>
    <p className="text-xs leading-6 text-zinc-600">已记录覆盖 {summary.coveredBlockIds.length} 个内容块，跳过 {summary.skippedBlockIds.length} 个。覆盖记录不代表掌握。</p>
    <dl className="grid grid-cols-2 gap-2 text-xs text-zinc-700 sm:grid-cols-4">
      {[["已提交", summary.attempts.total], ["记录正确", summary.attempts.correct], ["记录有误", summary.attempts.incorrect], ["尚未核对", summary.attempts.unverified]].map(([label, count]) => <div key={label}><dt className="text-zinc-500">{label}</dt><dd className="mt-1 font-medium tabular-nums">{count}</dd></div>)}
    </dl>
    {summary.openQuestions.length ? <div><p className="text-xs font-medium text-zinc-700">下次可继续核对</p><ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-zinc-600">{summary.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
    {summary.taskId && task ? <div className="space-y-2 border-t border-emerald-200 pt-3">
      <p className="text-sm text-zinc-800">把「{task.title}」标记为完成？</p>
      <p className="text-xs text-zinc-500">由你确认，结束学习不会自动完成任务。</p>
      <TaskQueueRefreshContext.Provider value={onReread}><TaskStatusControl task={task} api={api} disabled={false} /></TaskQueueRefreshContext.Provider>
    </div> : null}
    {summary.taskId && !task ? <p className="text-xs text-zinc-500">关联任务当前不可用，学习小结已保留。</p> : null}
    {next ? <div className="space-y-1 border-t border-emerald-200 pt-3">
      <button type="button" className={ui.primary} disabled={next.pending} onClick={next.start} data-teaching-next-section="true">{next.pending ? "正在准备下一节…" : "再学一节"}</button>
      <p className="text-xs leading-5 text-zinc-500">接着本节往下讲，不重复已讲内容；本节记录保持不变。</p>
      {next.error ? <p role="alert" className="text-xs text-red-700">{next.error}</p> : null}
    </div> : <p className="text-xs leading-6 text-zinc-500">想接着学：回到今日页点「再学一节」，或在今日队列中对任务选「开始任务主讲」，会开始新的一节，本节记录保持不变。</p>}
  </section>;
}

export function ActivitySummaryCard({ activityId, api: apiProp, onNextActivity }: {
  activityId: string;
  api?: OpeningApi;
  onNextActivity?: (activity: TeachingActivity) => void;
}) {
  const refreshQueue = useContext(TaskQueueRefreshContext);
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const client = useMemo(() => createTeachingActivityClient(), []);
  const [summary, setSummary] = useState<TeachingActivitySummary | null>(null);
  const [task, setTask] = useState<TaskItem | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const next = await client.getSummary(activityId);
      setSummary(next);
      if (next.taskId) {
        const result = await api.listTasks();
        setTask(result.tasks.find((row) => row.id === next.taskId) ?? null);
      } else setTask(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "无法读取学习小结"); }
  }, [activityId, api, client]);
  useEffect(() => { void load(); }, [load]);
  const [nextPending, setNextPending] = useState(false);
  const [nextError, setNextError] = useState("");
  const nextInFlight = useRef(false);
  async function startNext() {
    if (!onNextActivity || nextInFlight.current) return;
    nextInFlight.current = true; setNextPending(true); setNextError("");
    // Idempotent on the server: a retry after an unknown result lands on the same section.
    try { onNextActivity(await api.continueTeachingActivity(activityId)); }
    catch (reason) { setNextError(reason instanceof Error ? reason.message : "下一节还没有确认创建，可以再点一次。"); }
    finally { nextInFlight.current = false; setNextPending(false); }
  }
  return <div className="space-y-2">
    {summary ? <ActivitySummaryContent summary={summary} task={task} api={api} onReread={() => { refreshQueue?.(); void load(); }}
      {...(onNextActivity ? { next: { start: () => { void startNext(); }, pending: nextPending, error: nextError } } : {})} /> : <p role="status" className="text-xs text-zinc-500">正在读取学习小结…</p>}
    {error ? <div role="alert" className="space-y-2 text-xs text-red-700"><p>{error}</p><button type="button" className={ui.secondary} onClick={() => { void load(); }}>重新读取</button></div> : null}
  </div>;
}
