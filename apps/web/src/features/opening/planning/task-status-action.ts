import type { TaskItem, TaskStatusUpdateInput } from "@aistudy/contracts";
import { OpeningApiError } from "../client/api";

export type TaskStatusTarget = { taskId: string; expectedVersion: number };
export type TaskStatusUpdate = (taskId: string, input: TaskStatusUpdateInput) => Promise<TaskItem>;
export type TaskStatusResult =
  | { kind: "updated"; task: TaskItem }
  | { kind: "unknown" }
  | { kind: "rejected"; status: number };
export type TaskStatusNoticeState = { kind: "idle" } | { kind: "pending" } | TaskStatusResult;

/** One displayed task version, one in-flight write; uncertain outcomes never auto-retry. */
export function createTaskStatusAttempt(update: TaskStatusUpdate, target: TaskStatusTarget, status: "done" | "skipped", at: Date) {
  let inFlight = false, settled = false;
  return {
    async confirm(): Promise<TaskStatusResult | null> {
      if (inFlight || settled) return null;
      inFlight = true;
      try {
        const task = await update(target.taskId, { status, expectedVersion: target.expectedVersion, at: at.toISOString() });
        settled = true;
        return { kind: "updated", task };
      } catch (error) {
        settled = true;
        if (error instanceof OpeningApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
          return { kind: "rejected", status: error.status };
        }
        return { kind: "unknown" };
      } finally {
        inFlight = false;
      }
    },
  };
}

/** Complete and skip share one attempt, so a second action cannot send another PATCH. */
export function createTaskStatusSession(update: TaskStatusUpdate, target: TaskStatusTarget) {
  let attempt: ReturnType<typeof createTaskStatusAttempt> | null = null;
  return {
    confirm(status: "done" | "skipped", at: Date) {
      attempt ??= createTaskStatusAttempt(update, target, status, at);
      return attempt.confirm();
    },
  };
}

export function taskStatusVersionBlock(version: number | undefined): string | null {
  return version == null ? "任务版本尚未读取，请重新读取任务后再操作；不会猜测版本。" : null;
}

export function taskStatusNotice(state: TaskStatusNoticeState): string | null {
  if (state.kind === "idle" || state.kind === "updated") return null;
  if (state.kind === "pending") return "正在更新任务状态…";
  if (state.kind === "unknown") return "结果尚未确认，请先核对任务是否已经完成或跳过。本次不会自动重试。";
  if (state.status === 409) return "任务已更新，请重新读取";
  if (state.status === 404) return "这项任务已不存在或不可访问。";
  if (state.status === 400) return "任务状态无法更新，请核对当前任务后再试。";
  return "任务状态更新失败，请核对后再试。";
}
