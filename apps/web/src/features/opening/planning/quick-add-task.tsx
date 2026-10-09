"use client";

import { useContext, useRef, useState, type FormEvent } from "react";
import { taskCreateInputSchema, type TaskCreateInput, type TaskCreateResult } from "@aistudy/contracts";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { buttonClass, inputClass, secondaryButtonClass } from "../design/ui";
import { TaskQueueRefreshContext } from "./task-status-control";

export const QUICK_ADD_MINUTES = [15, 25, 45] as const;
export const QUICK_ADD_DEFAULT_MINUTES = 25;
export const QUICK_ADD_TITLE_MAX = 240;

export type QuickAddDraft = {
  title: string;
  minutes: (typeof QUICK_ADD_MINUTES)[number];
  /** YYYY-MM-DD or empty */
  dueDate: string;
  /** HH:mm or empty; empty with a date means end-of-day 23:59 local ("当日内") */
  dueTime: string;
};

export type QuickAddResult =
  | { kind: "created"; task: TaskCreateResult }
  | { kind: "failed"; message: string }
  | { kind: "unknown" };

export function newQuickAddClientKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `quick-add-${crypto.randomUUID()}`
    : `quick-add-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Date-only → local 23:59; date+time → that local instant; empty → no deadline. */
export function resolveQuickAddDueAt(dueDate: string, dueTime: string): string | null {
  const date = dueDate.trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("请填写有效的截止日期。");
  }
  const time = dueTime.trim();
  const local = time
    ? (/^\d{2}:\d{2}$/.test(time) ? `${date}T${time}:00` : null)
    : `${date}T23:59:00`;
  if (!local) throw new Error("请填写有效的截止时间。");
  const value = new Date(local);
  if (!Number.isFinite(value.getTime())) throw new Error("请填写有效的截止日期时间。");
  return value.toISOString();
}

export function dueWithinDayLabel(dueDate: string, dueTime: string): boolean {
  return Boolean(dueDate.trim()) && !dueTime.trim();
}

export function buildQuickAddInput(draft: QuickAddDraft, clientKey: string): TaskCreateInput {
  const title = draft.title.trim();
  if (!title) throw new Error("请填写任务名称。");
  if (title.length > QUICK_ADD_TITLE_MAX) throw new Error("任务名称不能超过 240 字。");
  if (!(QUICK_ADD_MINUTES as readonly number[]).includes(draft.minutes)) {
    throw new Error("请选择 15、25 或 45 分钟。");
  }
  return taskCreateInputSchema.parse({
    title,
    minutes: draft.minutes,
    dueAt: resolveQuickAddDueAt(draft.dueDate, draft.dueTime),
    priority: 1,
    candidateId: null,
    clientKey,
  });
}

/**
 * One add intent → one clientKey. Retries of the same intent reuse it.
 * Validation failure clears the key so a corrected payload is a new intent.
 * Unknown outcomes keep the key but callers must not auto-retry.
 */
export function createQuickAddAttempt(
  create: (input: TaskCreateInput) => Promise<TaskCreateResult>,
  mint: () => string = newQuickAddClientKey,
) {
  let clientKey: string | undefined;
  let inFlight = false;
  return {
    clientKey(): string | undefined {
      return clientKey;
    },
    async submit(draft: QuickAddDraft): Promise<QuickAddResult | null> {
      if (inFlight) return null;
      clientKey ??= mint();
      let input: TaskCreateInput;
      try {
        input = buildQuickAddInput(draft, clientKey);
      } catch (error) {
        clientKey = undefined;
        return { kind: "failed", message: error instanceof Error ? error.message : "请检查任务内容后重试。" };
      }
      inFlight = true;
      try {
        const task = await create(input);
        clientKey = undefined;
        return { kind: "created", task };
      } catch (error) {
        if (error instanceof OpeningApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
          clientKey = undefined;
          return { kind: "failed", message: error.message || "任务未能添加，请核对后重试。" };
        }
        return { kind: "unknown" };
      } finally {
        inFlight = false;
      }
    },
    /** After a successful add or an explicit fresh form, start a new intent. */
    reset() {
      clientKey = undefined;
    },
  };
}

const emptyDraft = (): QuickAddDraft => ({
  title: "",
  minutes: QUICK_ADD_DEFAULT_MINUTES,
  dueDate: "",
  dueTime: "",
});

export function QuickAddTask({
  api,
  disabled = false,
  onAdded,
}: {
  api: Pick<OpeningApi, "createTask">;
  disabled?: boolean;
  onAdded?: () => void;
}) {
  const reread = useContext(TaskQueueRefreshContext);
  const [draft, setDraft] = useState<QuickAddDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [open, setOpen] = useState(false);
  const attemptRef = useRef(createQuickAddAttempt((input) => api.createTask(input)));

  function resetForm() {
    attemptRef.current.reset();
    setDraft(emptyDraft());
    setError("");
    setUnknown(false);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled || unknown) return;
    setBusy(true);
    setError("");
    const result = await attemptRef.current.submit(draft);
    setBusy(false);
    if (!result) return;
    if (result.kind === "created") {
      resetForm();
      setOpen(false);
      onAdded?.();
      reread?.();
      return;
    }
    if (result.kind === "failed") {
      setError(result.message);
      return;
    }
    setUnknown(true);
    onAdded?.();
    reread?.();
  }

  return (
    <div className="border-b border-zinc-200/70 px-4 py-3">
      {!open ? (
        <button
          type="button"
          className={`${secondaryButtonClass} w-full`}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          快速添加任务
        </button>
      ) : (
        <form className="space-y-3" onSubmit={(event) => void onSubmit(event)} aria-label="快速添加任务">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-zinc-800">快速添加</h3>
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={busy}
              onClick={() => {
                if (!busy) {
                  resetForm();
                  setOpen(false);
                }
              }}
            >
              取消
            </button>
          </div>
          <label className="block text-xs text-zinc-600">
            任务名称
            <input
              required
              maxLength={QUICK_ADD_TITLE_MAX}
              value={draft.title}
              disabled={busy || unknown || disabled}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              className={`${inputClass} mt-1`}
              placeholder="例如：整理错题"
            />
          </label>
          <fieldset disabled={busy || unknown || disabled} className="space-y-1">
            <legend className="text-xs text-zinc-600">预计时长</legend>
            <div className="flex flex-wrap gap-2" role="group" aria-label="预计时长">
              {QUICK_ADD_MINUTES.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  aria-pressed={draft.minutes === minutes}
                  className={draft.minutes === minutes ? buttonClass : secondaryButtonClass}
                  onClick={() => setDraft((current) => ({ ...current, minutes }))}
                >
                  {minutes} 分钟
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-zinc-600">
              截止日期（可留空）
              <input
                type="date"
                value={draft.dueDate}
                disabled={busy || unknown || disabled}
                onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))}
                className={`${inputClass} mt-1`}
              />
            </label>
            <label className="block text-xs text-zinc-600">
              截止时间（可留空）
              <input
                type="time"
                value={draft.dueTime}
                disabled={busy || unknown || disabled || !draft.dueDate}
                onChange={(event) => setDraft((current) => ({ ...current, dueTime: event.target.value }))}
                className={`${inputClass} mt-1`}
              />
            </label>
          </div>
          {dueWithinDayLabel(draft.dueDate, draft.dueTime) ? (
            <p className="text-[11px] leading-5 text-zinc-500">未填具体时刻时，截止为当日内（当日 23:59）。没有确定时间不造截止。</p>
          ) : !draft.dueDate ? (
            <p className="text-[11px] leading-5 text-zinc-500">没有确定时间不造截止。新任务进入「其他待办」，不改变已确认计划。</p>
          ) : null}
          {error ? <p className="text-xs leading-5 text-red-700" role="alert">{error}</p> : null}
          {unknown ? (
            <div className="space-y-2">
              <p className="text-xs leading-5 text-amber-800" role="status">可能已添加，正在核对</p>
              <button
                type="button"
                className={secondaryButtonClass}
                onClick={() => {
                  onAdded?.();
                  reread?.();
                }}
              >
                重新读取
              </button>
            </div>
          ) : (
            <button type="submit" disabled={busy || disabled || !draft.title.trim()} className={`${buttonClass} w-full`}>
              {busy ? "正在添加…" : "添加任务"}
            </button>
          )}
        </form>
      )}
    </div>
  );
}
