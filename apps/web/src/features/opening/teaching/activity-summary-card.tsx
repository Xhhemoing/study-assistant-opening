"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { TaskItem, TeachingActivity, TeachingActivitySummary } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { TaskQueueRefreshContext, TaskStatusControl } from "../planning/task-status-control";
import { createTeachingActivityClient } from "./activity-client";
import { ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";
import { CourseRouteNextControl } from "../courses/course-route-next-control";
import { conversationObjectHref } from "../assistant/conversation-links";
import { TransitionLink as Link } from "../v3/motion/view-transition";

export function ActivitySummaryContent({ summary, task, api, onReread, activity, originalConversationId }: {
  summary: TeachingActivitySummary;
  task: TaskItem | null;
  api: Pick<OpeningApi, "updateTaskStatus">;
  onReread: () => void;
  activity?: TeachingActivity;
  originalConversationId?: string | null;
}) {
  const courseId = activity?.courseId;
  const focus = activity?.learnerFocus;
  const step = summary.nextStep;
  const matrixPractice = step?.kind === "assisted_check" ? step.matrixPractice : undefined;
  const practiceHref = courseId && step?.kind === "assisted_check" ? conversationObjectHref(
    `/opening/courses/${encodeURIComponent(courseId)}/study?${new URLSearchParams(matrixPractice ? {
      mode: "matrix", exercise: matrixPractice.exerciseKey, variant: String(matrixPractice.variant), sourceId: matrixPractice.sourceId,
    } : {
      mode: "practice",
      ...(focus ? { skillLabel: focus.skillLabel } : {}),
      ...(focus?.requirementKey ? { requirementKey: focus.requirementKey } : {}),
    })}`, originalConversationId,
  ) : null;
  return <section className="space-y-4 rounded-card border border-line bg-surface p-5 shadow-card" aria-label="本次学习小结">
    <h3 className="text-sm font-semibold text-text">本次学习已结束</h3>
    <p className="text-xs leading-6 text-text-2 tabular-nums">已记录覆盖 {summary.coveredBlockIds.length} 个内容块，跳过 {summary.skippedBlockIds.length} 个。覆盖记录不代表掌握。</p>
    <dl className="grid grid-cols-2 gap-2.5 text-xs text-text-2 sm:grid-cols-4">
      {[["已提交", summary.attempts.total], ["记录正确", summary.attempts.correct], ["记录有误", summary.attempts.incorrect], ["尚未核对", summary.attempts.unverified]].map(([label, count]) => <div key={label} className="well-recessed rounded-xl px-3 py-2.5"><dt className="text-text-3">{label}</dt><dd className="mt-1 text-sm font-semibold tabular-nums text-text">{count}</dd></div>)}
    </dl>
    {summary.openQuestions.length ? <div><p className="text-xs font-medium text-text-2">下次可继续核对</p><ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-5 text-text-2">{summary.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
    {summary.taskId && task ? <div className="space-y-2 border-t border-line pt-3.5">
      {task.status === "pending" ? <>
        <p className="text-sm font-medium text-text">把「{task.title}」标记为完成？</p>
        <p className="text-xs text-text-2">由你确认，结束学习不会自动完成任务。</p>
      </> : <p className="text-sm font-medium text-text">关联任务「{task.title}」</p>}
      <TaskQueueRefreshContext.Provider value={onReread}><TaskStatusControl task={task} api={api} disabled={false} /></TaskQueueRefreshContext.Provider>
    </div> : null}
    {summary.taskId && !task ? <p className="text-xs text-text-2">关联任务当前不可用，学习小结已保留。</p> : null}
    {activity?.routeManaged ? <CourseRouteNextControl activity={activity} originalConversationId={originalConversationId}
      summaryStep={step ?? null} onEvidenceChanged={onReread} />
      : practiceHref ? <div className="space-y-2 border-t border-line pt-3">
        <p className="text-xs leading-6 text-text-2">{matrixPractice
          ? "这次借助了帮助，可以用同一份材料独立试做一道同类题，提交后自动核算。"
          : "这次借助了帮助。你可以自选一道同类题，自己填写题目和作答结果。"}</p>
        <Link className={ui.primary} href={practiceHref}>{matrixPractice ? "独立试做同类题" : "记录自选练习"}</Link>
      </div> : courseId && step?.kind === "schedule_retest" ? <div className="space-y-2 border-t border-line pt-3">
        <p className="text-xs leading-6 text-text-2">本次已独立答对，可以查看后续复测建议。</p>
        <Link className={ui.primary} href="/opening/suggestions">查看延迟复测建议</Link>
      </div> : <p className="text-xs leading-6 text-text-2">可以从课程路线接着学，也可回到今日页开始新的一节。</p>}
  </section>;
}

export function ActivitySummaryCard({ activityId, activity, originalConversationId, api: apiProp }: {
  activityId: string; activity?: TeachingActivity; originalConversationId?: string | null; api?: OpeningApi;
}) {
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
      if (current()) setFailure({ activityId, message: userFacingMessage(reason, "无法读取学习小结") });
    }
  }, [activityId, api, client]);
  useEffect(() => { void load(); return () => { request.current++; }; }, [load]);
  const visible = snapshot?.activityId === activityId ? snapshot : null;
  const error = failure?.activityId === activityId ? failure.message : "";
  return <div className="space-y-2">
    {visible ? <ActivitySummaryContent summary={visible.summary} task={visible.task} api={api} activity={activity}
      originalConversationId={originalConversationId} onReread={() => { refreshQueue?.(); void load(); }} /> : !error ? <p role="status" className="text-xs text-text-2">正在读取学习小结…</p> : null}
    {error ? <div role="alert" className="space-y-2 text-xs text-danger"><p>{error}</p><button type="button" className={ui.secondary} onClick={() => { void load(); }}>重新读取</button></div> : null}
  </div>;
}
