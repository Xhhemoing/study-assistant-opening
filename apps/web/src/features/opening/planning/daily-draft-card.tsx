"use client";

import type { PlanDraft, SuggestionFeedbackInput, SuggestionFeedbackResult, TaskFeedbackInput, TaskItem } from "@aistudy/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { OpeningApi } from "../client/api";
import { buttonClass, secondaryButtonClass } from "../design/ui";
import { canAcceptPlan } from "./plan-action";
import { runSeedTodayPlan } from "./seed-today-plan";
import { planAcceptFailure } from "./plan-accept-errors";
import { AdaptiveDraftPreview } from "./adaptive-draft-preview";
import { normalizeSuggestedSelection, reconcileSuggestedSelection, selectableSuggestedKeys } from "./daily-draft-selection";

export type DailyDraftSkippedReason = "accepted" | "rejected" | "no_settings";

export type DailyDraftControllers = {
  accept: (draft: PlanDraft, selectedKeys?: readonly string[]) => Promise<PlanDraft>;
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
      : `daily-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
  ));
  const acceptKeys = new Map<string, string>();
  const accepting = new Map<string, Promise<PlanDraft>>();
  return {
    accept(draft, selectedKeys = []) {
      const acceptSuggestedKeys = normalizeSuggestedSelection(draft, selectedKeys);
      const identity = JSON.stringify([draft.id, draft.baseVersion, acceptSuggestedKeys]);
      const inflight = accepting.get(identity);
      if (inflight) return inflight;
      let clientKey = acceptKeys.get(identity);
      if (!clientKey) { clientKey = mint(); acceptKeys.set(identity, clientKey); }
      const request = api.acceptPlan({
        draftId: draft.id,
        expectedBaseVersion: draft.baseVersion,
        clientKey,
        acceptSuggestedKeys,
      }).finally(() => { accepting.delete(identity); });
      accepting.set(identity, request);
      return request;
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
  selectedSuggestedKeys?: readonly string[];
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
    | { type: "select"; keys: readonly string[] }
    | { type: "hydrate"; draft: PlanDraft | null },
): DailyDraftCardModel {
  switch (event.type) {
    case "accept_ok":
    case "reject_ok":
      return { draft: null, error: "" };
    case "adjust_ok":
    case "hydrate":
      return {
        draft: event.draft,
        error: "",
        selectedSuggestedKeys: reconcileSuggestedSelection(state.draft, state.selectedSuggestedKeys ?? selectableSuggestedKeys(state.draft), event.draft),
      };
    case "action_fail":
      return { ...state, error: event.message };
    case "clear_error":
      return { ...state, error: "" };
    case "select":
      return state.draft ? { ...state, selectedSuggestedKeys: normalizeSuggestedSelection(state.draft, event.keys) } : state;
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
  adaptivePlanning = false,
  hasNewerSuggestion = false,
  onRefreshSuggestions,
}: {
  api: Pick<
    OpeningApi,
    "proposePlan" | "acceptPlan" | "rejectPlan" | "getPlanningSettings" | "putPlanningSettings" | "createTask"
  > & { submitSuggestionFeedback?: (input: SuggestionFeedbackInput) => Promise<SuggestionFeedbackResult> };
  date: string;
  acceptedVersion?: number;
  dailyDraft?: PlanDraft | null;
  dailyDraftSkippedReason?: DailyDraftSkippedReason | null;
  unplannedPendingCount?: number;
  tasks?: readonly TaskItem[];
  onChanged?: () => void;
  adaptivePlanning?: boolean;
  hasNewerSuggestion?: boolean;
  onRefreshSuggestions?: () => void | Promise<void>;
}) {
  const controllers = useMemo(
    () => createDailyDraftControllers(api, { date }),
    [api, date],
  );
  const [model, setModel] = useState<DailyDraftCardModel>(() => ({
    draft: seedDraft(dailyDraft),
    error: "",
    selectedSuggestedKeys: selectableSuggestedKeys(seedDraft(dailyDraft)),
  }));
  const [pending, setPending] = useState(false);
  const [seedError, setSeedError] = useState("");
  const [feedbackBlocked, setFeedbackBlocked] = useState(false);
  const feedbackKeys = useRef(new Map<string, string>());
  const action = useRef<symbol | null>(null);
  const scope = `${date}:${dailyDraft?.id ?? ""}:${dailyDraft?.baseVersion ?? ""}:${dailyDraft?.version ?? ""}:${dailyDraft?.status ?? ""}:${dailyDraftSkippedReason ?? ""}:${acceptedVersion}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const hydratedScope = useRef(scope);

  useEffect(() => {
    const changed = hydratedScope.current !== scope;
    hydratedScope.current = scope;
    if (changed) { action.current = null; setPending(false); setFeedbackBlocked(false); }
    if (dailyDraftSkippedReason != null) {
      setModel((prev) => (prev.draft == null && prev.error === "" ? prev : { draft: null, error: "" }));
      return;
    }
    const next = seedDraft(dailyDraft);
    setModel((prev) => {
      if (!changed) return prev;
      return reduceDailyDraftCard(prev, { type: "hydrate", draft: next });
    });
  }, [dailyDraft, dailyDraftSkippedReason, scope]);
  useEffect(() => () => { action.current = null; }, []);

  const draft = model.draft;
  const selectedKeys = model.selectedSuggestedKeys ?? selectableSuggestedKeys(draft);
  const stale = Boolean(draft && draft.baseVersion !== acceptedVersion);
  function beginAction(readOnly = false): symbol | null {
    if (action.current || (feedbackBlocked && !readOnly)) return null;
    const token = Symbol(); action.current = token; setPending(true);
    return token;
  }
  function isCurrent(token: symbol): boolean { return action.current === token && currentScope.current === scope; }
  function finishAction(token: symbol) { if (isCurrent(token)) { action.current = null; setPending(false); } }

  async function onSeedDefaultPlan() {
    const token = beginAction();
    if (!token) return;
    setSeedError("");
    try {
      await runSeedTodayPlan(api, { target: { kind: "default" } });
      if (!isCurrent(token)) return;
      onChanged?.();
    } catch (reason) {
      if (!isCurrent(token)) return;
      setSeedError(reason instanceof Error ? reason.message : "用默认作息生成本日计划失败，请重试。");
    } finally {
      finishAction(token);
    }
  }

  if (dailyDraftSkippedReason === "accepted" && (unplannedPendingCount ?? 0) === 0) return null;
  if (dailyDraftSkippedReason) {
    return (
      <section
        className="space-y-2 border-b border-line bg-warn-soft px-4 py-3"
        aria-labelledby="daily-draft-skipped-heading"
      >
        <h3 className="text-xs font-semibold text-text" id="daily-draft-skipped-heading">
          今日推荐草案
        </h3>
        <p className="text-xs leading-5 text-text-2" role="status">
          {dailyDraftSkippedCopy(dailyDraftSkippedReason, unplannedPendingCount)}
        </p>
        {dailyDraftSkippedReason === "no_settings" ? (
          <div className="space-y-2">
            <button
              type="button"
              className={secondaryButtonClass}
              disabled={pending}
              onClick={() => void onSeedDefaultPlan()}
            >
              {pending ? "正在生成…" : "用默认作息生成本日计划"}
            </button>
            {seedError ? (
              <p className="text-xs leading-5 text-danger" role="alert">{seedError}</p>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  if (!draft) return null;

  async function onConfirm() {
    if (!draft || !canAcceptPlan({ pending, stale })) return;
    const token = beginAction();
    if (!token) return;
    setModel((prev) => reduceDailyDraftCard(prev, { type: "clear_error" }));
    try {
      await controllers.accept(draft, adaptivePlanning ? selectedKeys : []);
      if (!isCurrent(token)) return;
      setModel((prev) => reduceDailyDraftCard(prev, { type: "accept_ok" }));
      onChanged?.();
    } catch (reason) {
      if (!isCurrent(token)) return;
      const failure = planAcceptFailure(reason);
      setModel((prev) => reduceDailyDraftCard(prev, {
        type: "action_fail",
        message: failure.message,
      }));
      if (failure.reread) onChanged?.();
    } finally {
      finishAction(token);
    }
  }

  async function onReject() {
    if (!draft || pending) return;
    const token = beginAction();
    if (!token) return;
    setModel((prev) => reduceDailyDraftCard(prev, { type: "clear_error" }));
    try {
      await controllers.reject(draft.id);
      if (!isCurrent(token)) return;
      setModel((prev) => reduceDailyDraftCard(prev, { type: "reject_ok" }));
      onChanged?.();
    } catch (reason) {
      if (!isCurrent(token)) return;
      setModel((prev) => reduceDailyDraftCard(prev, {
        type: "action_fail",
        message: reason instanceof Error ? reason.message : "拒绝草案失败，草案已保留，请重试。",
      }));
    } finally {
      finishAction(token);
    }
  }

  async function onAdjust() {
    if (!draft || pending) return;
    const token = beginAction();
    if (!token) return;
    setModel((prev) => reduceDailyDraftCard(prev, { type: "clear_error" }));
    try {
      const next = await controllers.adjust();
      if (!isCurrent(token)) return;
      setModel((prev) => reduceDailyDraftCard(prev, { type: "adjust_ok", draft: next }));
    } catch (reason) {
      if (!isCurrent(token)) return;
      setModel((prev) => reduceDailyDraftCard(prev, {
        type: "action_fail",
        message: reason instanceof Error ? reason.message : "重新提议失败，原草案已保留。",
      }));
    } finally {
      finishAction(token);
    }
  }

  async function rejectSuggestion(suggestionKey: string, reason?: TaskFeedbackInput["reason"]) {
    if (!draft || !api.submitSuggestionFeedback) return;
    const token = beginAction();
    if (!token) return;
    const identity = JSON.stringify([draft.id, draft.version, suggestionKey, reason ?? null]);
    let clientKey = feedbackKeys.current.get(identity);
    if (!clientKey) { clientKey = `suggestion-feedback:${crypto.randomUUID()}`; feedbackKeys.current.set(identity, clientKey); }
    try {
      const result = await api.submitSuggestionFeedback({ draftId: draft.id, expectedDraftVersion: draft.version,
        suggestionKey, clientKey, ...(reason ? { reason } : {}) });
      if (!isCurrent(token)) return;
      setModel(prev => reduceDailyDraftCard(prev, { type: "adjust_ok", draft: result.draft }));
      onChanged?.();
    } catch {
      if (!isCurrent(token)) return;
      setFeedbackBlocked(true);
      setModel(prev => reduceDailyDraftCard(prev, { type: "action_fail", message: "反馈结果尚未确认或草案已变化，请先重新读取；不会自动重试。" }));
    } finally { finishAction(token); }
  }

  async function refreshSuggestions() {
    const refresh = adaptivePlanning ? onRefreshSuggestions ?? onChanged : onChanged;
    if (!refresh) return;
    const token = beginAction(true);
    if (!token) return;
    try { await refresh(); if (isCurrent(token)) setFeedbackBlocked(false); }
    catch (reason) {
      if (isCurrent(token)) setModel((prev) => reduceDailyDraftCard(prev, { type: "action_fail", message: reason instanceof Error ? reason.message : "读取新建议失败，原草案已保留。" }));
    } finally { finishAction(token); }
  }

  return (
    <section
      className="space-y-3 border-b border-line bg-surface-2 px-4 py-4"
      aria-labelledby="daily-draft-heading"
    >
      <div>
        <h3 className="text-xs font-semibold text-text" id="daily-draft-heading">今日推荐草案</h3>
        <p className="mt-1 text-xs leading-5 text-text-3">
          基于待办、到期补测、课表空闲与昨日顺延生成；确认后才改变正式计划。
        </p>
      </div>
      {adaptivePlanning && hasNewerSuggestion && onRefreshSuggestions ? <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void refreshSuggestions()}>有新建议 · 点击更新</button> : null}
      {draft.blocks.some((block) => draft.reasons?.[block.taskId]?.code === "carry_over") ? (
        <p className="text-xs leading-5 text-warn" role="status">含顺延自昨天的任务</p>
      ) : null}
      {adaptivePlanning ? <AdaptiveDraftPreview draft={draft} tasks={tasks} selectedKeys={selectedKeys} disabled={pending || feedbackBlocked}
        onRejectSuggestion={api.submitSuggestionFeedback && draft.origin !== "agent" ? rejectSuggestion : undefined}
        onSelectionChange={(keys) => { if (!action.current && !feedbackBlocked) setModel((prev) => reduceDailyDraftCard(prev, { type: "select", keys })); }} /> : <ul className="space-y-2 text-xs leading-5 text-text-2" aria-label="推荐安排">
        {draft.blocks.map((block) => (
          <li key={`${block.taskId}-${block.start}`}>
            <span className="font-medium text-text">{taskTitle(tasks, block.taskId)}</span>
            <p>{timeLabel(block.start)}–{timeLabel(block.end)}</p>
            {(draft.reasons?.[block.taskId]?.label ?? block.reason) ? <p className="text-text-3">{draft.reasons?.[block.taskId]?.label ?? block.reason}</p> : null}
          </li>
        ))}
      </ul>}
      {draft.unscheduledTaskIds.length ? (
        <p className="text-xs text-warn">
          未安排 {draft.unscheduledTaskIds.length} 项；可确认后改用「按建议安排」或缩短时长。
        </p>
      ) : null}
      {stale ? (
        <p className="text-xs leading-5 text-warn">计划版本已变化。请拒绝旧草案或调整后重新确认。</p>
      ) : null}
      {model.error ? <div className="space-y-2"><p className="text-xs leading-5 text-danger" role="alert">{model.error}</p>{onChanged || onRefreshSuggestions ? <button type="button" className={secondaryButtonClass} disabled={pending} onClick={() => void refreshSuggestions()}>{adaptivePlanning && onRefreshSuggestions ? "刷新草案" : "重新读取"}</button> : null}</div> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={feedbackBlocked || !canAcceptPlan({ pending, stale })}
          onClick={() => void onConfirm()}
        >
          {pending ? "正在处理…" : "确认"}
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={pending || feedbackBlocked}
          onClick={() => void onAdjust()}
        >
          调整
        </button>
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={pending || feedbackBlocked}
          onClick={() => void onReject()}
        >
          拒绝
        </button>
      </div>
    </section>
  );
}
