"use client";

import { CircleCheck } from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";
import type { TaskFeedbackInput } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { inputClass, secondaryButtonClass } from "../design/ui";
import type { StudyTask } from "./study-task";
import { createTaskStatusSession, taskDeferralUntilTomorrow, taskStatusNotice, taskStatusVersionBlock, type TaskStatusNoticeState } from "./task-status-action";

export const TaskPlanningTimeZoneContext = createContext<string | null>(null);
export const TaskQueueRefreshContext = createContext<(() => void) | null>(null);

/** True only when a task payload already carries a retest marker. Listing that marker is DL3; this sends no extra request. */
export function isRetestOriginTask(task: object): boolean {
  if (!("retest" in task) && !("retestOrigin" in task)) return false;
  const record = task as { retest?: unknown; retestOrigin?: boolean };
  if (record.retestOrigin === true) return true;
  return record.retest != null;
}

type PanelTask = { status: "pending" | "done" | "skipped"; version?: number };

export function TaskStatusPanel({ task, retestOrigin = false, confirmingSkip = false, disabled = false, notice, noticeRole = "alert", showReread = false, onComplete, onArmSkip, onConfirmSkip, onCancelSkip, onReread, onArmDefer, onResume, confirmingDefer = false, feedbackReason = "", onReasonChange }: {
  task: PanelTask;
  retestOrigin?: boolean;
  confirmingSkip?: boolean;
  disabled?: boolean;
  notice?: string | null;
  noticeRole?: "alert" | "status";
  showReread?: boolean;
  onComplete?: () => void;
  onArmSkip?: () => void;
  onConfirmSkip?: () => void;
  onCancelSkip?: () => void;
  onReread?: () => void;
  onArmDefer?: () => void;
  onResume?: () => void;
  confirmingDefer?: boolean;
  feedbackReason?: TaskFeedbackInput["reason"] | "";
  onReasonChange?: (value: TaskFeedbackInput["reason"] | "") => void;
}) {
  if (task.status !== "pending") {
    return <p className="text-[11px] text-zinc-500">{task.status === "done" ? "已完成" : "已跳过"}</p>;
  }
  const versionBlock = taskStatusVersionBlock(task.version);
  const unavailable = disabled || Boolean(versionBlock);
  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    {retestOrigin ? <p className="w-full text-[11px] leading-5 text-amber-800">建议先完成补测作答</p> : null}
    {versionBlock ? <p className="w-full text-[11px] leading-5 text-amber-800">{versionBlock}</p> : null}
    {confirmingSkip || confirmingDefer ? <>
      <p className="w-full text-[11px] leading-5 text-zinc-600">{confirmingDefer ? "推迟至工作区明天开始；已确认安排将保留，可再调整。" : "跳过需要再次确认后才会提交，且不能撤销。"}</p>
      <label className="w-full text-[11px] text-zinc-600">原因（可不选）
        <select className={`${inputClass} ml-2 max-w-full`} value={feedbackReason} disabled={disabled} onChange={event => onReasonChange?.(event.target.value as TaskFeedbackInput["reason"] | "")}>
          <option value="">不填写</option><option value="time_short">时间不够</option><option value="too_hard">太难</option><option value="too_easy">太简单</option><option value="not_relevant">不适合当前目标</option><option value="other">其他原因</option><option value="prefer_not_say">不愿说明</option>
        </select>
      </label>
      <button type="button" className={secondaryButtonClass} disabled={unavailable} onClick={onConfirmSkip}>{confirmingDefer ? "确认推迟" : "确认跳过"}</button>
      <button type="button" className={secondaryButtonClass} disabled={disabled} onClick={onCancelSkip}>取消</button>
    </> : <>
      <button type="button" className={secondaryButtonClass} disabled={unavailable} onClick={onComplete}><CircleCheck size={13} aria-hidden />标记完成</button>
      <button type="button" className={secondaryButtonClass} disabled={unavailable} onClick={onArmSkip}>跳过</button>
      {onArmDefer ? <button type="button" className={secondaryButtonClass} disabled={unavailable} onClick={onArmDefer}>推迟到明天</button> : null}
      {onResume ? <button type="button" className={secondaryButtonClass} disabled={unavailable} onClick={onResume}>取消推迟</button> : null}
    </>}
    {notice ? <p role={noticeRole} className={`w-full text-[11px] leading-5 ${noticeRole === "alert" ? "text-amber-800" : "text-zinc-600"}`}>{notice}</p> : null}
    {showReread ? <button type="button" className={secondaryButtonClass} onClick={onReread}>重新读取</button> : null}
  </div>;
}

export function TaskStatusControl({ task, api, disabled, retestOrigin = false }: {
  task: StudyTask;
  api: Pick<OpeningApi, "updateTaskStatus"> & Partial<Pick<OpeningApi, "deferTask">>;
  disabled: boolean;
  retestOrigin?: boolean;
}) {
  const reread = useContext(TaskQueueRefreshContext);
  const timeZone = useContext(TaskPlanningTimeZoneContext);
  const [state, setState] = useState<TaskStatusNoticeState>({ kind: "idle" });
  const [confirmation, setConfirmation] = useState<"skipped" | "deferred" | null>(null);
  const [feedbackReason, setFeedbackReason] = useState<TaskFeedbackInput["reason"] | "">("");
  const sessionKey = task.id + ":" + String(task.version ?? "missing");
  const [trackedKey, setTrackedKey] = useState(sessionKey);
  const sessionRef = useRef<ReturnType<typeof createTaskStatusSession> | null>(null);
  const keyRef = useRef(sessionKey);
  if (keyRef.current !== sessionKey) {
    keyRef.current = sessionKey;
    sessionRef.current = null;
  }
  const keyChanged = trackedKey !== sessionKey;
  if (keyChanged) {
    setTrackedKey(sessionKey);
    setState({ kind: "idle" });
    setConfirmation(null);
    setFeedbackReason("");
  }
  const viewState: TaskStatusNoticeState = keyChanged ? { kind: "idle" } : state;
  const busy = viewState.kind === "pending";
  const locked = busy || viewState.kind === "unknown" || viewState.kind === "rejected" || viewState.kind === "updated";
  const notice = viewState.kind === "updated" && task.status === "pending" ? "正在重新读取任务…" : taskStatusNotice(viewState);
  const noticeRole = viewState.kind === "pending" || viewState.kind === "updated" ? "status" : "alert";

  async function commit(status: "done" | "skipped" | "deferred" | "resumed") {
    if (disabled || locked || task.status !== "pending" || task.version == null) return;
    const keyAtStart = keyRef.current;
    let session = sessionRef.current;
    if (!session) {
      session = createTaskStatusSession(
        (taskId, input) => api.updateTaskStatus(taskId, input),
        { taskId: task.id, expectedVersion: task.version },
        api.deferTask ? (taskId, input) => api.deferTask!(taskId, input) : undefined,
      );
      sessionRef.current = session;
      setConfirmation(null);
      setFeedbackReason("");
      setState({ kind: "pending" });
    }
    const feedback = feedbackReason ? { reason: feedbackReason } : undefined;
    const result = status === "deferred" || status === "resumed"
      ? await session.defer(status === "resumed" ? null : taskDeferralUntilTomorrow(new Date(), timeZone!), feedback)
      : await session.confirm(status, new Date(), feedback);
    if (!result || keyRef.current !== keyAtStart) return;
    if (result.kind === "updated" && result.task.version === task.version) {
      // A checked no-op (for example the same deferral) does not advance the
      // version. Let the learner take another action after this confirmed read.
      sessionRef.current = null;
      setState({ kind: "idle" });
    } else setState(result);
    if (result.kind === "updated") reread?.();
  }

  return <TaskStatusPanel
    task={task}
    retestOrigin={retestOrigin || isRetestOriginTask(task)}
    confirmingSkip={!keyChanged && confirmation === "skipped"}
    confirmingDefer={!keyChanged && confirmation === "deferred"}
    feedbackReason={keyChanged ? "" : feedbackReason}
    onReasonChange={setFeedbackReason}
    disabled={disabled || locked}
    notice={notice}
    noticeRole={noticeRole}
    showReread={Boolean(reread) && (viewState.kind === "unknown" || viewState.kind === "rejected")}
    onComplete={() => { void commit("done"); }}
    onArmSkip={() => { if (!disabled && !locked && task.version != null) setConfirmation("skipped"); }}
    onConfirmSkip={() => { void commit(confirmation ?? "skipped"); }}
    onCancelSkip={() => { setConfirmation(null); setFeedbackReason(""); }}
    onArmDefer={timeZone && api.deferTask ? () => { setConfirmation("deferred"); setFeedbackReason(""); } : undefined}
    onResume={api.deferTask && task.notBefore ? () => { void commit("resumed"); } : undefined}
    onReread={() => reread?.()}
  />;
}
