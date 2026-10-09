"use client";

import type { PlanDraft, PlannedBlock, TaskItem } from "@aistudy/contracts";
import { useEffect, useMemo, useState } from "react";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { buttonClass, secondaryButtonClass } from "../design/ui";
import { canAcceptPlan } from "./plan-action";

export type DailyDraftSkippedReason = "accepted" | "rejected" | "no_settings";

export type DailyDraftControllers = {
  accept: (draft: PlanDraft) => Promise<PlanDraft>;
  reject: (draftId: string) => Promise<PlanDraft>;
  /** Re-propose only — never auto-accepts. Caller confirms separately. */
  adjust: () => Promise<PlanDraft>;
};

/**
 * Factory for confirm / reject / re-propose. Accept is never called from adjust.
 */
export function createDailyDraftControllers(
  api: Pick<OpeningApi, "proposePlan" | "acceptPlan" | "rejectPlan">,
  options: { date: string; mintClientKey?: () => string },
): DailyDraftControllers {
  const mint = options.mintClientKey ?? (() => (
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `daily-draft-${crypto.randomUUID()}`
      : `daily-draft-${Date.now()}`
  ));
  return {
    async accept(draft) {
      return api.acceptPlan({
        draftId: draft.id,
        expectedBaseVersion: draft.baseVersion,
        clientKey: mint(),
      });
    },
    async reject(draftId) {
      return api.rejectPlan(draftId);
    },
    async adjust() {
      return api.proposePlan({ date: options.date, clientKey: mint() });
    },
  };
}

export function dailyDraftSkippedCopy(
  reason: DailyDraftSkippedReason,
  unplannedPendingCount?: number,
): string {
  if (reason === "accepted") {
    const n = unplannedPendingCount ?? 0;
    return `有 ${n} 项新任务未排入`;
  }
  if (reason === "rejected") {
    return "今日推荐草案已拒绝，今天不会再自动生成。可用「按建议安排」手动生成。";
  }
  return "尚未完成学期设置，无法生成今日推荐草案。请先完成课表与可用时间设置。";
}

export type DailyDraftCardModel = {
  draft: PlanDraft | null;
  error: string;
};

/** Pure reducer so failure paths never clear or invent draft state. */
export function reduceDailyDraftCard(
  state: DailyDraftCardModel,
  event:
    | { type: "accept_ok" }
    | { type: "reject_ok" }
    | { type: "adjust_ok"; draft: PlanDraft }
    | { type: "action_fail"; message: string }
    | { type: "clear_error" }
    | { type: "hydrate"; draft: PlanDraft | null },
): DailyDraftCardModel {
  switch (event.type) {
    case "accept_ok":
    case "reject_ok":
      return { draft: null, error: "" };
    case "adjust_ok":
      return { draft: event.draft, error: "" };
    case "action_fail":
      return { draft: state.draft, error: event.message };
    case "clear_error":
      return { ...state, error: "" };
    case "hydrate":
      return { draft: event.draft, error: "" };
    default:
      return state;
  }
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function taskTitle(tasks: readonly TaskItem[], taskId: string): string {
  return tasks.find((task) => task.id === taskId)?.title ?? "学习任务";
}

function hasCarryOverReason(blocks: readonly PlannedBlock[]): boolean {
  return blocks.some((block) => block.reason.includes("顺延自昨天"));
}

function seedDraft(dailyDraft: PlanDraft | null | undefined): PlanDraft | null {
  return dailyDraft && dailyDraft.status === "draft" ? dailyDraft : null;
}

export function DailyDraftCard({
  api,
  date,
  acceptedVersion = 0,
  dailyDraft = null,
  dailyDraftSkippedReason = null,
  unplannedPendingCount,
  tasks = [],
  onChanged,
}: {
  api: Pick<OpeningApi, "proposePlan" | "acceptPlan" | "rejectPlan">;
  date: string;
  acceptedVersion?: number;
  dailyDraft?: PlanDraft | null;
  dailyDraftSkippedReason?: DailyDraftSkippedReason | null;
  unplannedPendingCount?: number;
  tasks?: readonly TaskItem[];
  onChanged?: () => void;
}) {
  const controllers = useMemo(
    () => createDailyDraftControllers(api, { date }),
    [api, date],
  );
  const [model, setModel] = useState<DailyDraftCardModel>(() => ({
    draft: seedDraft(dailyDraft),
    error: "",
  }));
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (pending) return;
    if (dailyDraftSkippedReason != null) {
      setModel((prev) => (prev.draft == null && prev.error === "" ? prev : { draft: null, error: "" }));
      return;
    }
    const next = seedDraft(dailyDraft);
    setModel((prev) => {
      if (prev.error !== "") return prev;
      if (prev.draft?.id === next?.id) return prev;
      return reduceDailyDraftCard(prev, { type: "hydrate", draft: next });
    });
  }, [dailyDraft, dailyDraftSkippedReason, pending]);

  const draft = model.draft;
  const stale = Boolean(draft && draft.baseVersion !== acceptedVersion);

  if (dailyDraftSkippedReason) {
    return (
      <section
        className="space-y-2 border-b border-zinc-200 bg-amber-50/60 px-4 py-3"
        aria-labelledby="daily-draft-skipped-heading"
      >
        <h3 className="text-xs font-semibold text-zinc-800" id="daily-draft-skipped-heading">
          今日推荐草案
        </h3>
        <p className="text-xs leading-5 text-zinc-700" role="status">
          {dailyDraftSkippedCopy(dailyDraftSkippedReason, unplannedPendingCount)}
        </p>
      </section>
    );
  }

  if (!draft) return null;

  async function onConfirm() {
    if (!draft || !canAcceptPlan({ pending, stale })) return;
    setPending(true);
    setModel((prev) => reduceDailyDraftCard(prev, { type: "clear_error" }));
    try {
      await controllers.accept(draft);
      setModel((prev) => reduceDailyDraftCard(prev, { type: "accept_ok" }));
      onChanged?.();
    } catch (reason) {
      setModel((prev) => reduceDailyDraftCard(prev, {
        type: "action_fail",
        message: reason instanceof OpeningApiError && reason.status === 409
          ? "计划已变化，请重新读取后再确认；没有重复提交。"
          : reason instanceof Error ? reason.message : "确认推荐草案失败",
      }));
    } finally {
      setPending(false);
    }
  }

  async function onReject() {
    if (!draft || pending) return;
    setPending(true);
    setModel((prev) => reduceDailyDraftCard(prev, { type: "clear_error" }));
    try {
      await controllers.reject(draft.id);
      setModel((prev) => reduceDailyDraftCard(prev, { type: "reject_ok" }));
      onChanged?.();
    } catch (reason) {
      setModel((prev) => reduceDailyDraftCard(prev, {
        type: "action_fail",
        message: reason instanceof Error ? reason.message : "拒绝草案失败，草案已保留，请重试。",
      }));
    } finally {
      setPending(false);
    }
  }

  async function onAdjust() {
    if (!draft || pending) return;
    setPending(true);
    setModel((prev) => reduceDailyDraftCard(prev, { type: "clear_error" }));
    try {
      const next = await controllers.adjust();
      setModel((prev) => reduceDailyDraftCard(prev, { type: "adjust_ok", draft: next }));
    } catch (reason) {
      setModel((prev) => reduceDailyDraftCard(prev, {
        type: "action_fail",
        message: reason instanceof Error ? reason.message : "重新提议失败，原草案已保留。",
      }));
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      className="space-y-3 border-b border-emerald-200 bg-emerald-50/40 px-4 py-4"
      aria-labelledby="daily-draft-heading"
    >
      <div>
        <h3 className="text-xs font-semibold text-zinc-800" id="daily-draft-heading">今日推荐草案</h3>
        <p className="mt-1 text-[11px] leading-5 text-zinc-500">
          基于待办、到期补测、课表空闲与昨日顺延生成；确认后才改变正式计划。
        </p>
      </div>
      {hasCarryOverReason(draft.blocks) ? (
        <p className="text-[11px] leading-5 text-amber-900" role="status">含顺延自昨天的任务</p>
      ) : null}
      <ul className="space-y-2 text-xs leading-5 text-zinc-700" aria-label="推荐安排">
        {draft.blocks.map((block) => (
          <li key={`${block.taskId}-${block.start}`}>
            <span className="font-medium text-zinc-900">{taskTitle(tasks, block.taskId)}</span>
            <p>{timeLabel(block.start)}–{timeLabel(block.end)}</p>
            {block.reason ? <p className="text-zinc-500">{block.reason}</p> : null}
          </li>
        ))}
      </ul>
      {draft.unscheduledTaskIds.length ? (
        <p className="text-xs text-amber-800">
          未安排 {draft.unscheduledTaskIds.length} 项；可确认后改用「按建议安排」或缩短时长。
        </p>
      ) : null}
      {stale ? (
        <p className="text-xs leading-5 text-amber-800">计划版本已变化。请拒绝旧草案或调整后重新确认。</p>
      ) : null}
      {model.error ? <p className="text-xs leading-5 text-red-700" role="alert">{model.error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!canAcceptPlan({ pending, stale })}
          onClick={() => void onConfirm()}
        >
          {pending ? "正在处理…" : "确认"}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={pending}
          onClick={() => void onAdjust()}
        >
          调整
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={pending}
          onClick={() => void onReject()}
        >
          拒绝
        </button>
      </div>
    </section>
  );
}
