"use client";

import { CircleCheck } from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { secondaryButtonClass } from "../design/ui";
import type { StudyTask } from "./study-task";
import { createTaskStatusSession, taskStatusNotice, taskStatusVersionBlock, type TaskStatusNoticeState } from "./task-status-action";

export const TaskQueueRefreshContext = createContext<(() => void) | null>(null);

/** True only when a task payload already carries a retest marker. Listing that marker is DL3; this sends no extra request. */
export function isRetestOriginTask(task: object): boolean {
  if (!("retest" in task) && !("retestOrigin" in task)) return false;
  const record = task as { retest?: unknown; retestOrigin?: boolean };
  if (record.retestOrigin === true) return true;
  return record.retest != null;
}

type PanelTask = { status: "pending" | "done" | "skipped"; version?: number };

export function TaskStatusPanel({ task, retestOrigin = false, confirmingSkip = false, disabled = false, notice, noticeRole = "alert", showReread = false, onComplete, onArmSkip, onConfirmSkip, onCancelSkip, onReread }: {
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
}) {
  if (task.status !== "pending") {
    return <p className="text-[11px] text-zinc-500">{task.status === "done" ? "已完成" : "已跳过"}</p>;
  }
  const versionBlock = taskStatusVersionBlock(task.version);
  const unavailable = disabled || Boolean(versionBlock);
  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    {retestOrigin ? <p className="w-full text-[11px] leading-5 text-amber-800">建议先完成补测作答</p> : null}
    {versionBlock ? <p className="w-full text-[11px] leading-5 text-amber-800">{versionBlock}</p> : null}
    {confirmingSkip ? <>
      <p className="w-full text-[11px] leading-5 text-zinc-600">跳过需要再次确认后才会提交，且不能撤销。</p>
      <button type="button" className={secondaryButtonClass} disabled={unavailable} onClick={onConfirmSkip}>确认跳过</button>
      <button type="button" className={secondaryButtonClass} disabled={disabled} onClick={onCancelSkip}>取消</button>
    </> : <>
      <button type="button" className={secondaryButtonClass} disabled={unavailable} onClick={onComplete}><CircleCheck size={13} aria-hidden />标记完成</button>
      <button type="button" className={secondaryButtonClass} disabled={unavailable} onClick={onArmSkip}>跳过</button>
    </>}
    {notice ? <p role={noticeRole} className={`w-full text-[11px] leading-5 ${noticeRole === "alert" ? "text-amber-800" : "text-zinc-600"}`}>{notice}</p> : null}
    {showReread ? <button type="button" className={secondaryButtonClass} onClick={onReread}>重新读取</button> : null}
  </div>;
}

export function TaskStatusControl({ task, api, disabled, retestOrigin = false }: {
  task: StudyTask;
  api: Pick<OpeningApi, "updateTaskStatus">;
  disabled: boolean;
  retestOrigin?: boolean;
}) {
  const reread = useContext(TaskQueueRefreshContext);
  const [state, setState] = useState<TaskStatusNoticeState>({ kind: "idle" });
  const [confirmingSkip, setConfirmingSkip] = useState(false);
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
    setConfirmingSkip(false);
  }
  const viewState: TaskStatusNoticeState = keyChanged ? { kind: "idle" } : state;
  const busy = viewState.kind === "pending";
  const locked = busy || viewState.kind === "unknown" || viewState.kind === "rejected" || viewState.kind === "updated";
  const notice = viewState.kind === "updated" && task.status === "pending" ? "正在重新读取任务…" : taskStatusNotice(viewState);
  const noticeRole = viewState.kind === "pending" || viewState.kind === "updated" ? "status" : "alert";

  async function commit(status: "done" | "skipped") {
    if (disabled || locked || task.status !== "pending" || task.version == null) return;
    const keyAtStart = keyRef.current;
    let session = sessionRef.current;
    if (!session) {
      session = createTaskStatusSession(
        (taskId, input) => api.updateTaskStatus(taskId, input),
        { taskId: task.id, expectedVersion: task.version },
      );
      sessionRef.current = session;
      setConfirmingSkip(false);
      setState({ kind: "pending" });
    }
    const result = await session.confirm(status, new Date());
    if (!result || keyRef.current !== keyAtStart) return;
    setState(result);
    if (result.kind === "updated") reread?.();
  }

  return <TaskStatusPanel
    task={task}
    retestOrigin={retestOrigin || isRetestOriginTask(task)}
    confirmingSkip={keyChanged ? false : confirmingSkip}
    disabled={disabled || locked}
    notice={notice}
    noticeRole={noticeRole}
    showReread={Boolean(reread) && (viewState.kind === "unknown" || viewState.kind === "rejected")}
    onComplete={() => { void commit("done"); }}
    onArmSkip={() => { if (!disabled && !locked && task.version != null) setConfirmingSkip(true); }}
    onConfirmSkip={() => { void commit("skipped"); }}
    onCancelSkip={() => setConfirmingSkip(false)}
    onReread={() => reread?.()}
  />;
}
