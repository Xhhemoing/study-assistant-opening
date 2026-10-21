"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { TaskItem, TeachingActivitySummary } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { TaskQueueRefreshContext, TaskStatusControl } from "../planning/task-status-control";
import { createTeachingActivityClient } from "./activity-client";
import { ui } from "../design/ui";

export function ActivitySummaryContent({ summary, task, api, onReread }: {
  summary: TeachingActivitySummary;
  task: TaskItem | null;
  api: Pick<OpeningApi, "updateTaskStatus">;
  onReread: () => void;
}) {
  return <section className="space-y-3 rounded-xl border border-accent/30 bg-accent-soft p-4" aria-label="本次学习小结">
    <h3 className="text-sm font-semibold text-text">本次学习已结束</h3>
    <p className="text-xs leading-6 text-text-2">已记录覆盖 {summary.coveredBlockIds.length} 个内容块，跳过 {summary.skippedBlockIds.length} 个。覆盖记录不代表掌握。</p>
    <dl className="grid grid-cols-2 gap-2 text-xs text-text-2 sm:grid-cols-4">
      {[["已提交", summary.attempts.total], ["记录正确", summary.attempts.correct], ["记录有误", summary.attempts.incorrect], ["尚未核对", summary.attempts.unverified]].map(([label, count]) => <div key={label}><dt className="text-text-2">{label}</dt><dd className="mt-1 font-medium tabular-nums">{count}</dd></div>)}
    </dl>
    {summary.openQuestions.length ? <div><p className="text-xs font-medium text-text-2">下次可继续核对</p><ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-5 text-text-2">{summary.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
    {summary.taskId && task ? <div className="space-y-2 border-t border-accent/30 pt-3">
      <p className="text-sm text-text">把「{task.title}」标记为完成？</p>
      <p className="text-xs text-text-2">由你确认，结束学习不会自动完成任务。</p>
      <TaskQueueRefreshContext.Provider value={onReread}><TaskStatusControl task={task} api={api} disabled={false} /></TaskQueueRefreshContext.Provider>
    </div> : null}
    {summary.taskId && !task ? <p className="text-xs text-text-2">关联任务当前不可用，学习小结已保留。</p> : null}
    <p className="text-xs leading-6 text-text-2">想接着学：回到今日页点「开始学习」，或在今日队列中对任务选「开始此项」，会开始新的一节，本节记录保持不变。</p>
  </section>;
}

export function ActivitySummaryCard({ activityId, api: apiProp }: { activityId: string; api?: OpeningApi }) {
  const refreshQueue = useContext(TaskQueueRefreshContext);
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const client = useMemo(() => createTeachingActivityClient(), []);
  const [snapshot, setSnapshot] = useState<{ activityId: string; summary: TeachingActivitySummary; task: TaskItem | null } | null>(null);
  const [failure, setFailure] = useState<{ activityId: string; message: string } | null>(null);
  const request = useRef(0);
  const currentActivity = useRef(activityId);
  currentActivity.current = activityId;
  const load = useCallback(async () => {
    const version = ++request.current;
    setFailure(null);
    const current = () => version === request.current && currentActivity.current === activityId;
    try {
      const summary = await client.getSummary(activityId);
      if (!current()) return;
      let task: TaskItem | null = null;
      if (summary.taskId) {
        const result = await api.listTasks();
        task = result.tasks.find((row) => row.id === summary.taskId) ?? null;
      }
      // A summary and its linked task are one snapshot. Never pair a new
      // summary with the previous activity's task while the second read waits.
      if (current()) setSnapshot({ activityId, summary, task });
    } catch (reason) {
      if (current()) setFailure({ activityId, message: reason instanceof Error ? reason.message : "无法读取学习小结" });
    }
  }, [activityId, api, client]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  const visible = snapshot?.activityId === activityId ? snapshot : null;
  const error = failure?.activityId === activityId ? failure.message : "";
  return <div className="space-y-2">
    {visible ? <ActivitySummaryContent summary={visible.summary} task={visible.task} api={api} onReread={() => { refreshQueue?.(); void load(); }} /> : <p role="status" className="text-xs text-text-2">正在读取学习小结…</p>}
    {error ? <div role="alert" className="space-y-2 text-xs text-danger"><p>{error}</p><button type="button" className={ui.secondary} onClick={() => { void load(); }}>重新读取</button></div> : null}
  </div>;
}
