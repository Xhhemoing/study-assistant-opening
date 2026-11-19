"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dayAdjustmentConfirmReceiptSchema,
  dayAdjustmentPreviewSchema,
  dayExceptionReceiptSchema,
  type DayAdjustmentConfirmInput,
  type DayAdjustmentConfirmReceipt,
  type DayAdjustmentPreview,
  type DayAdjustmentPreviewInput,
  type DayExceptionDeclareInput,
  type DayExceptionReceipt,
  type PlannedBlock,
} from "@aistudy/contracts";
import { buttonClass, ui } from "../design/ui";
import { userFacingMessage } from "../../../lib/user-facing-error";

export class DayAdjustmentRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly reason?: string;

  constructor(message: string, status: number, code?: string, reason?: string) {
    super(message);
    this.name = "DayAdjustmentRequestError";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

export type DayAdjustmentDeclareResponse = {
  action: "declare_today";
  receipt: DayExceptionReceipt;
  preview: DayAdjustmentPreview | null;
};

export type DayAdjustmentConfirmResponse = {
  action: "confirm";
  receipt: DayAdjustmentConfirmReceipt;
  preview: DayAdjustmentPreview | null;
};

export type DayAdjustmentClient = {
  getPreview(input?: DayAdjustmentPreviewInput): Promise<DayAdjustmentPreview>;
  declareToday(input: DayExceptionDeclareInput): Promise<DayAdjustmentDeclareResponse>;
  preview(input: DayAdjustmentPreviewInput): Promise<DayAdjustmentPreview>;
  confirm(input: DayAdjustmentConfirmInput): Promise<DayAdjustmentConfirmResponse>;
};

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function throwForFailedResponse(response: Response, body: unknown): never {
  const err = body && typeof body === "object" && "error" in body
    ? (body as { error?: { message?: string; code?: string; reason?: string } }).error
    : undefined;
  throw new DayAdjustmentRequestError(
    err?.message || "操作暂时未能完成，请稍后重试。",
    response.status,
    err?.code,
    err?.reason,
  );
}

export function createDayAdjustmentClient(
  fetchImpl: typeof fetch = fetch,
): DayAdjustmentClient {
  return {
    async getPreview(input) {
      const params = new URLSearchParams();
      if (input?.date) params.set("date", input.date);
      if (input?.targetDate) params.set("targetDate", input.targetDate);
      if (input?.quickTaskId) params.set("quickTaskId", input.quickTaskId);
      if (input?.moveTaskIds?.length) params.set("moveTaskIds", input.moveTaskIds.join(","));
      if (input?.removeTaskIds?.length) params.set("removeTaskIds", input.removeTaskIds.join(","));
      const query = params.toString();
      const url = query
        ? `/api/opening/plans/day-adjustment?${query}`
        : "/api/opening/plans/day-adjustment";
      const response = await fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = await parseJsonResponse(response);
      if (!response.ok) throwForFailedResponse(response, body);
      return dayAdjustmentPreviewSchema.parse(body);
    },

    async declareToday(input) {
      const response = await fetchImpl("/api/opening/plans/day-adjustment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ action: "declare_today", ...input }),
      });
      const body = await parseJsonResponse(response);
      if (!response.ok) throwForFailedResponse(response, body);
      const record = body as { receipt: unknown; preview?: unknown };
      return {
        action: "declare_today",
        receipt: dayExceptionReceiptSchema.parse(record.receipt),
        preview: record.preview == null ? null : dayAdjustmentPreviewSchema.parse(record.preview),
      };
    },

    async preview(input) {
      const response = await fetchImpl("/api/opening/plans/day-adjustment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ action: "preview", ...input }),
      });
      const body = await parseJsonResponse(response);
      if (!response.ok) throwForFailedResponse(response, body);
      const record = body as { preview: unknown };
      return dayAdjustmentPreviewSchema.parse(record.preview);
    },

    async confirm(input) {
      const response = await fetchImpl("/api/opening/plans/day-adjustment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ action: "confirm", ...input }),
      });
      const body = await parseJsonResponse(response);
      if (!response.ok) throwForFailedResponse(response, body);
      const record = body as { receipt: unknown; preview?: unknown };
      return {
        action: "confirm",
        receipt: dayAdjustmentConfirmReceiptSchema.parse(record.receipt),
        preview: record.preview == null ? null : dayAdjustmentPreviewSchema.parse(record.preview),
      };
    },
  };
}

function formatBlockRange(block: PlannedBlock, timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${formatter.format(new Date(block.start))}–${formatter.format(new Date(block.end))}`;
  } catch {
    return `${block.start.slice(11, 16)}–${block.end.slice(11, 16)}`;
  }
}

type PendingAction =
  | { kind: "declare"; input: DayExceptionDeclareInput }
  | { kind: "confirm"; input: DayAdjustmentConfirmInput };

const PRESET_MINUTES = [15, 30, 45] as const;

export function TodayDayAdjustment({
  date,
  timeZone,
  client: suppliedClient,
  onChanged,
  defaultOpen = false,
}: {
  date: string;
  timeZone: string;
  client?: DayAdjustmentClient;
  onChanged?: () => void;
  defaultOpen?: boolean;
}) {
  const client = useMemo(() => suppliedClient ?? createDayAdjustmentClient(), [suppliedClient]);
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [preview, setPreview] = useState<DayAdjustmentPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [minutesInput, setMinutesInput] = useState("15");
  const [targetDateInput, setTargetDateInput] = useState("");
  const [selectedQuickTaskId, setSelectedQuickTaskId] = useState<string | null>(null);
  const [selectedMoveTaskIds, setSelectedMoveTaskIds] = useState<string[] | undefined>(undefined);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);

  const hasDayException = Boolean(preview?.dayException);
  useEffect(() => {
    if (hasDayException) setIsOpen(true);
  }, [hasDayException]);

  const loadPreview = useCallback(
    async (options?: {
      targetDate?: string;
      quickTaskId?: string | null;
      moveTaskIds?: string[];
      usePost?: boolean;
      preserveError?: boolean;
    }) => {
      setLoading(true);
      if (!options?.preserveError) setError("");
      try {
        const params: DayAdjustmentPreviewInput = {
          date,
          ...(options?.targetDate ? { targetDate: options.targetDate } : {}),
          ...(options?.quickTaskId !== undefined ? { quickTaskId: options.quickTaskId } : {}),
          ...(options?.moveTaskIds !== undefined ? { moveTaskIds: options.moveTaskIds } : {}),
        };
        const next = options?.usePost
          ? await client.preview(params)
          : await client.getPreview(params);
        setPreview(next);
        if (next.dayException) {
          setMinutesInput(String(next.dayException.remainingMinutes));
        }
        if (next.targetDate && !options?.targetDate) {
          setTargetDateInput(next.targetDate);
        }
      } catch (reason) {
        if (!options?.preserveError) {
          setError(userFacingMessage(reason, "今日时间调整暂无法读取，请稍后刷新重试。"));
        }
      } finally {
        setLoading(false);
      }
    },
    [client, date],
  );

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  async function runDeclare(input: DayExceptionDeclareInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPending({ kind: "declare", input });
    try {
      const result = await client.declareToday(input);
      setPending(null);
      setSelectedQuickTaskId(null);
      setSelectedMoveTaskIds(undefined);
      setMinutesInput(String(result.receipt.remainingMinutes));
      setNotice(`已记录今天剩余 ${result.receipt.remainingMinutes} 分钟，原有安排尚未改动，请核对下方调整方案。`);
      if (result.preview) {
        setPreview(result.preview);
        if (result.preview.targetDate) setTargetDateInput(result.preview.targetDate);
      } else {
        void loadPreview();
      }
    } catch (reason) {
      if (reason instanceof DayAdjustmentRequestError && reason.status === 409) {
        setPending(null);
        setSelectedQuickTaskId(null);
        setSelectedMoveTaskIds(undefined);
        setError(userFacingMessage(reason, "今日安排刚刚发生变化，请刷新后再重新声明。"));
        await loadPreview({ preserveError: true });
      } else if (reason instanceof DayAdjustmentRequestError && reason.status >= 400 && reason.status < 500) {
        setPending(null);
        setError(userFacingMessage(reason, "请检查今天剩余可用时长后再试。"));
      } else {
        setError(userFacingMessage(reason, "提交结果暂未确认，可点击下方按钮重试同一次操作。"));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function handleDeclareSubmit(minutesOverride?: number) {
    if (busy || pending !== null || !preview) return;
    const parsed = minutesOverride ?? Number(minutesInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600) {
      setError("今天剩余可用时长须为 1 至 600 之间的整数分钟。");
      return;
    }
    setMinutesInput(String(parsed));
    const input: DayExceptionDeclareInput = {
      clientKey: crypto.randomUUID(),
      localDate: preview.sourceDate,
      expectedTimeZone: preview.timeZone || timeZone,
      expectedExceptionRevision: preview.exceptionRevision,
      remainingMinutes: parsed,
    };
    void runDeclare(input);
  }

  async function handleRefreshWithSelection(next: {
    targetDate?: string;
    quickTaskId?: string | null;
    moveTaskIds?: string[];
  }) {
    if (busy) return;
    setBusy(true);
    try {
      await loadPreview({ ...next, usePost: true });
    } finally {
      setBusy(false);
    }
  }

  async function runConfirm(input: DayAdjustmentConfirmInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setPending({ kind: "confirm", input });
    try {
      const result = await client.confirm(input);
      setPending(null);
      setSelectedQuickTaskId(null);
      setSelectedMoveTaskIds(undefined);
      const movedSummary = result.receipt.targetDate
        ? `并同步改期到 ${result.receipt.targetDate}`
        : "";
      setNotice(`调整已确认，今日安排已更新${movedSummary}。`);
      onChanged?.();
      if (result.preview) {
        setPreview(result.preview);
      } else {
        void loadPreview();
      }
    } catch (reason) {
      if (reason instanceof DayAdjustmentRequestError && reason.status === 409) {
        setPending(null);
        setSelectedQuickTaskId(null);
        setSelectedMoveTaskIds(undefined);
        setError(userFacingMessage(reason, "安排或任务状态刚刚发生变化，已为你刷新最新方案，请核对后再确认。"));
        await loadPreview({ preserveError: true });
      } else if (reason instanceof DayAdjustmentRequestError && reason.status >= 400 && reason.status < 500) {
        setPending(null);
        setError(userFacingMessage(reason, "当前调整方案无法确认，请调整后再试。"));
      } else {
        setError(userFacingMessage(reason, "确认结果暂未返回，可点击下方按钮重试这次确认。"));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function handleConfirmClick() {
    if (busy || pending !== null || !preview || !preview.canConfirm || !preview.dayException) return;
    const hasTarget = Boolean(preview.targetDate && preview.targetAddedBlocks.length > 0);
    const input: DayAdjustmentConfirmInput = {
      clientKey: `day-adjust:${crypto.randomUUID()}`,
      sourceDate: preview.sourceDate,
      ...(preview.targetDate ? { targetDate: preview.targetDate } : {}),
      expectedTimeZone: preview.timeZone,
      expectedExceptionRevision: preview.exceptionRevision,
      expectedBudgetRevision: preview.budgetRevision,
      expectedSourceAcceptedVersion: preview.sourceAcceptedVersion,
      ...(hasTarget ? { expectedTargetAcceptedVersion: preview.targetAcceptedVersion ?? 0 } : {}),
      expectedTaskRevisions: preview.taskRevisions,
      expectedRetestRevisions: preview.retestRevisions,
      sourceActions: {
        keptBlocks: preview.keptBlocks,
        removedBlocks: preview.removedBlocks,
        addedBlocks: preview.sourceAddedBlocks,
      },
      targetActions: hasTarget && preview.targetDate
        ? {
            targetDate: preview.targetDate,
            addedBlocks: preview.targetAddedBlocks,
          }
        : null,
    };
    void runConfirm(input);
  }

  const taskTitle = useCallback(
    (taskId: string) => {
      const fromSummary = preview?.tasks.find((item) => item.taskId === taskId);
      if (fromSummary) return fromSummary.title;
      const fromQuick = preview?.quickCandidates.find((item) => item.taskId === taskId);
      return fromQuick?.title ?? "学习任务";
    },
    [preview],
  );

  const summaryText = preview?.dayException
    ? `今日临时调整 · 今天只剩 ${preview.dayException.remainingMinutes} 分钟`
    : loading
      ? "今日临时调整 · 读取中"
      : "今日时间有变？只剩 15 分钟也能快速重排";

  return (
    <details
      className="mx-4 my-2 space-y-3 rounded-panel border border-line bg-surface px-4 py-3 sm:mx-5"
      data-testid="today-day-adjustment"
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {summaryText}
      </summary>

      <div className="space-y-3 pt-1">
        <p className="text-xs leading-6 text-text-3">
          临时时间变紧时，先告诉系统今天还剩多少分钟；原有安排不会自动被覆盖，你可以预览保留、移出或跨日改期后再确认。
        </p>

        <div className="flex flex-wrap items-end gap-2">
          {PRESET_MINUTES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={ui.secondary}
              disabled={busy || loading || pending !== null || !preview}
              onClick={() => handleDeclareSubmit(minutes)}
            >
              今天只剩 {minutes} 分钟
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className={ui.label}>今天剩余可用分钟</span>
            <input
              aria-label="今天剩余可用分钟"
              className={ui.input}
              type="number"
              min={1}
              max={600}
              value={minutesInput}
              disabled={busy || pending !== null}
              onChange={(event) => setMinutesInput(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={ui.secondary}
            disabled={busy || loading || pending !== null || !preview}
            onClick={() => handleDeclareSubmit()}
          >
            记录今天可用时长
          </button>
          <button
            type="button"
            className={ui.quiet}
            disabled={busy || loading}
            onClick={() => void loadPreview()}
          >
            刷新最新状态
          </button>
        </div>

        {preview?.dayException ? (
          <div className="space-y-3 border-t border-line pt-3">
            <p className="text-xs leading-6 text-text-2" data-testid="day-adjustment-capacity">
              今日临时上限 {preview.dayException.remainingMinutes} 分钟 · 调整前需安排{" "}
              {preview.capacityBefore.requiredMinutes} 分钟
              {preview.capacityBefore.usageUncertain
                ? "（剩余时长待核对）"
                : preview.capacityBefore.shortfallMinutes > 0
                  ? `（超出 ${preview.capacityBefore.shortfallMinutes} 分钟）`
                  : ""}
              {" · "}调整后需安排 {preview.capacityAfter.requiredMinutes} 分钟
              {preview.capacityAfter.usageUncertain
                ? "（剩余时长待核对）"
                : preview.capacityAfter.shortfallMinutes > 0
                  ? `（仍缺 ${preview.capacityAfter.shortfallMinutes} 分钟）`
                  : "（可容纳）"}
            </p>

            {preview.status === "usage_uncertain" ? (
              <div
                role="status"
                data-testid="day-adjustment-uncertain"
                className="space-y-2 rounded-panel border border-line bg-surface p-3"
              >
                <p className="text-xs leading-6 text-warn">
                  当前存在跨过刚才调整时刻的学习记录，剩余可用时长暂无法准确确认。你声明的{" "}
                  {preview.dayException.remainingMinutes} 分钟已保留，请先刷新核对后再确认调整。
                </p>
                <button
                  type="button"
                  className={ui.secondary}
                  disabled={busy}
                  onClick={() => void loadPreview()}
                >
                  重新核对剩余时长
                </button>
              </div>
            ) : null}

            {preview.sourceBeforeBlocks.length > 0 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="space-y-1">
                    <span className={ui.label}>改期目标日期</span>
                    <input
                      aria-label="改期目标日期"
                      className={ui.input}
                      type="date"
                      value={targetDateInput || preview.targetDate || ""}
                      disabled={busy}
                      onChange={(event) => {
                        const nextDate = event.target.value;
                        setTargetDateInput(nextDate);
                        if (nextDate && nextDate > preview.sourceDate) {
                          void handleRefreshWithSelection({
                            targetDate: nextDate,
                            quickTaskId: selectedQuickTaskId,
                            moveTaskIds: selectedMoveTaskIds,
                          });
                        }
                      }}
                    />
                  </label>
                </div>

                <div className="space-y-1">
                  <p className="text-xs font-medium text-text">今日保留安排（{preview.keptBlocks.length} 项）</p>
                  {preview.keptBlocks.length > 0 ? (
                    <ul className="space-y-1 text-xs text-text-2">
                      {preview.keptBlocks.map((block) => (
                        <li key={`${block.taskId}:${block.start}`} className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            {taskTitle(block.taskId)} · {formatBlockRange(block, preview.timeZone)}
                          </span>
                          <button
                            type="button"
                            className={ui.quiet}
                            disabled={busy}
                            onClick={() => {
                              const currentMoved = preview.removedBlocks.map((item) => item.taskId);
                              const nextMove = [...new Set([...currentMoved, block.taskId])];
                              setSelectedMoveTaskIds(nextMove);
                              void handleRefreshWithSelection({
                                targetDate: targetDateInput || preview.targetDate || undefined,
                                quickTaskId: selectedQuickTaskId,
                                moveTaskIds: nextMove,
                              });
                            }}
                          >
                            改期移出
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-text-3">今日暂无保留时段。</p>
                  )}
                </div>

                {preview.removedBlocks.length > 0 ? (
                  <div className="space-y-1 border-l-2 border-accent pl-3">
                    <p className="text-xs font-medium text-text">
                      将从今日移出（{preview.removedBlocks.length} 项）
                    </p>
                    <ul className="space-y-1 text-xs text-text-2">
                      {preview.removedBlocks.map((block) => (
                        <li key={`${block.taskId}:${block.start}`} className="flex flex-wrap items-center justify-between gap-2">
                          <span>
                            {taskTitle(block.taskId)} · 原 {formatBlockRange(block, preview.timeZone)}
                          </span>
                          <button
                            type="button"
                            className={ui.quiet}
                            disabled={busy}
                            onClick={() => {
                              const nextMove = preview.removedBlocks
                                .map((item) => item.taskId)
                                .filter((id) => id !== block.taskId);
                              setSelectedMoveTaskIds(nextMove);
                              void handleRefreshWithSelection({
                                targetDate: targetDateInput || preview.targetDate || undefined,
                                quickTaskId: selectedQuickTaskId,
                                moveTaskIds: nextMove,
                              });
                            }}
                          >
                            留在今天
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {preview.targetAddedBlocks.length > 0 && preview.targetDate ? (
                  <div className="space-y-1 border-l-2 border-accent pl-3">
                    <p className="text-xs font-medium text-text">
                      将同步安排到 {preview.targetDate}（{preview.targetAddedBlocks.length} 项）
                    </p>
                    <ul className="space-y-1 text-xs text-text-2">
                      {preview.targetAddedBlocks.map((block) => (
                        <li key={`${block.taskId}:${block.start}`}>
                          {taskTitle(block.taskId)} · {preview.targetDate}{" "}
                          {formatBlockRange(block, preview.timeZone)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-text-3">今天目前还没有已确认的学习时段，可以从下方选择能完整放下的短任务。</p>
            )}

            {preview.sourceAddedBlocks.length > 0 ? (
              <div className="space-y-1 border-l-2 border-accent pl-3">
                <p className="text-xs font-medium text-text">今日新增快速安排</p>
                <ul className="space-y-1 text-xs text-text-2">
                  {preview.sourceAddedBlocks.map((block) => (
                    <li key={`${block.taskId}:${block.start}`}>
                      {taskTitle(block.taskId)} · {formatBlockRange(block, preview.timeZone)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.quickCandidates.length > 0 ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-text">今日快速插槽候选（须完整放下任务时长）</p>
                <ul className="space-y-1 text-xs text-text-2">
                  {preview.quickCandidates.slice(0, 5).map((candidate) => {
                    const selected = selectedQuickTaskId === candidate.taskId;
                    return (
                      <li key={candidate.taskId} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {candidate.title}（{candidate.minutes} 分钟）· {candidate.reason}
                        </span>
                        <button
                          type="button"
                          className={ui.quiet}
                          disabled={busy || !candidate.fits}
                          onClick={() => {
                            const nextId = selected ? null : candidate.taskId;
                            setSelectedQuickTaskId(nextId);
                            void handleRefreshWithSelection({
                              targetDate: targetDateInput || preview.targetDate || undefined,
                              quickTaskId: nextId,
                              moveTaskIds: selectedMoveTaskIds,
                            });
                          }}
                        >
                          {selected ? "取消补入" : candidate.fits ? "补入今日空档" : "时长放不下"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            {preview.blockers.map((blocker, index) => (
              <p key={index} role="status" className="text-xs text-warn">
                {blocker}
              </p>
            ))}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                className={buttonClass}
                data-testid="day-adjustment-confirm-btn"
                disabled={busy || pending !== null || !preview.canConfirm}
                onClick={handleConfirmClick}
              >
                {busy ? "正在确认…" : "确认这次调整"}
              </button>
              {preview.status === "no_change" ? (
                <span className="text-xs text-text-3">当前安排已在今日剩余时长内，无需改动。</span>
              ) : null}
            </div>
          </div>
        ) : null}

        {pending ? (
          <div role="status" className="space-y-2 border-t border-line pt-2">
            <p className="text-xs text-warn">
              刚才的操作结果暂未返回，你可以直接重试这次操作，系统不会重复改动你的安排。
            </p>
            <button
              type="button"
              className={ui.secondary}
              disabled={busy}
              onClick={() => {
                if (pending.kind === "declare") void runDeclare(pending.input);
                else void runConfirm(pending.input);
              }}
            >
              重试这次确认
            </button>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-xs text-text-2">
            {notice}
          </p>
        ) : null}
      </div>
    </details>
  );
}
