"use client";

import { Bell, LoaderCircle } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { secondaryButtonClass } from "../design/ui";

type ReminderTask = { id: string; title: string; status: "pending" | "done" | "skipped"; version?: number };
type ReminderApi = Pick<OpeningApi, "requestTaskReminder">;
export type TaskReminderResult = { kind: "queued" } | { kind: "unknown" } | { kind: "rejected"; status: number };
type TaskReminderState = TaskReminderResult | { kind: "idle" } | { kind: "pending" };

/** One displayed task version, one in-flight write; uncertain outcomes never auto-retry. */
export function createTaskReminderAttempt(request: ReminderApi["requestTaskReminder"], target: { taskId: string; expectedVersion: number }, makeKey: () => string = () => crypto.randomUUID()) {
  let inFlight = false, settled = false;
  let clientKey: string | undefined;
  return {
    async confirm(): Promise<TaskReminderResult | null> {
      if (inFlight || settled) return null;
      inFlight = true;
      try {
        clientKey ??= makeKey();
        await request({ ...target, channel: "in_app", clientKey });
        settled = true;
        return { kind: "queued" };
      } catch (error) {
        if (error instanceof OpeningApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
          return { kind: "rejected", status: error.status };
        }
        settled = true;
        return { kind: "unknown" };
      } finally {
        inFlight = false;
      }
    },
  };
}

export function TaskReminderStatus({ state }: { state: TaskReminderState }) {
  if (state.kind === "idle") return null;
  if (state.kind === "pending") return <p role="status" className="flex items-center gap-1.5 text-xs text-text-2"><LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />正在请求本次提醒…</p>;
  if (state.kind === "queued") return <p role="status" className="text-xs text-accent">已加入应用内提醒。</p>;
  if (state.kind === "unknown") return <p role="alert" className="text-xs leading-6 text-warn">请求结果尚未确认，可能已加入提醒。请先核对提醒状态，避免重复请求；本次不会自动重试。</p>;
  const message = state.status === 409 ? "任务已更新，请重新选择最新任务后再请求本次提醒。"
    : state.status === 404 ? "这项任务已不存在或不可访问，请重新选择任务。"
      : state.status === 422 ? "当前任务可能尚未到期或已结束，暂时无法加入到期提醒；请核对任务状态。"
        : state.status === 401 ? "登录已失效，请登录后再操作。" : "未能加入本次提醒，请核对当前任务后再试。";
  return <p role="alert" className="text-xs leading-6 text-danger">{message}</p>;
}

export function TaskReminder({ task, api, disabled }: { task: ReminderTask; api: ReminderApi; disabled: boolean }) {
  const descriptionId = useId();
  const [state, setState] = useState<TaskReminderState>({ kind: "idle" });
  const attempt = useMemo(() => task.version == null ? null
    : createTaskReminderAttempt(input => api.requestTaskReminder(input), { taskId: task.id, expectedVersion: task.version }), [api, task.id, task.version]);
  const unavailable = task.status !== "pending" ? "仅当前待办任务可以请求到期提醒。"
    : task.version == null ? "任务信息还没读完整，请重新读取任务后再试。" : null;
  const locked = state.kind === "queued" || state.kind === "unknown" || state.kind === "rejected" && [401, 404, 409].includes(state.status);
  const busy = state.kind === "pending";
  async function confirm() {
    if (!attempt || disabled || unavailable || locked || busy) return;
    setState({ kind: "pending" });
    const result = await attempt.confirm();
    if (result) setState(result);
  }
  return <details className="w-full border-t border-line py-1">
    <summary className="min-h-11 w-fit cursor-pointer rounded py-2 text-xs text-text-2 focus-visible:ring-2 focus-visible:ring-accent">仅本次到期提醒</summary>
    <div className="space-y-2 pb-2">
      <p id={descriptionId} className="text-xs leading-6 text-text-2">仅对「{task.title}」请求一次应用内到期提醒，不更改课程或全局自动提醒开关。课程归档或自动提醒关闭时，本次请求仍只针对这项任务。</p>
      <p className="text-xs leading-5 text-text-3">本操作不发送外部推送；是否已到期由服务器核对。</p>
      {unavailable ? <p className="text-xs leading-5 text-warn">{unavailable}</p> : null}
      <button type="button" className={secondaryButtonClass} aria-describedby={descriptionId} disabled={disabled || Boolean(unavailable) || busy || locked} onClick={() => { void confirm(); }}><Bell size={13} aria-hidden />{busy ? "正在请求…" : "加入应用内提醒"}</button>
      <TaskReminderStatus state={state} />
    </div>
  </details>;
}
