"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { EmptyState, PageHeader, secondaryButtonClass } from "../design/ui";
import { createReviewActions, loadReviewItems, retainUnconfirmedReviews, type ReviewApi } from "./review-service";
import { ReviewCard } from "./review-card";
import { reviewItemKey, type ReviewItem, type ReviewOutcome } from "./review-types";
import { useOpeningCapabilities } from "../capabilities/capabilities-provider";
import { supportsConversationPlan } from "./conversation-plan-controller";

type ReadState = { kind: "loading" | "ready" | "error" | "loggedOut"; items: ReviewItem[]; message?: string };
export function ReviewView({ api: supplied, embedded = false, onPendingCountChange, onDecision }: {
  api?: ReviewApi; embedded?: boolean; onPendingCountChange?: (count: number) => void; onDecision?: (outcome: ReviewOutcome) => void;
}) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const conversationApi = useOpeningCapabilities().adaptivePlanning && supportsConversationPlan(api) ? api : undefined;
  const actions = useMemo(() => createReviewActions(api), [api]);
  const [state, setState] = useState<ReadState>({ kind: "loading", items: [] });
  const [decidedKeys, setDecidedKeys] = useState<Set<string>>(() => new Set());
  const pendingCount = state.items.filter(item => !decidedKeys.has(reviewItemKey(item))).length;
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const items = await loadReviewItems(api);
      if (request !== requestId.current) return;
      setState((current) => ({ kind: "ready", items: retainUnconfirmedReviews(current.items, items, actions.pending) }));
    }
    catch (error) {
      if (request !== requestId.current) return;
      setState((current) => ({ ...current, kind: error instanceof OpeningApiError && error.status === 401 ? "loggedOut" : "error", message: error instanceof Error ? error.message : "暂时无法读取建议" }));
    }
  }, [api, actions]);
  useEffect(() => { void refresh(); return () => { requestId.current += 1; }; }, [refresh]);
  useEffect(() => {
    if (state.kind === "ready") onPendingCountChange?.(pendingCount);
  }, [state.kind, pendingCount, onPendingCountChange]);
  function decided(item: ReviewItem, outcome: ReviewOutcome) {
    setDecidedKeys(previous => new Set(previous).add(reviewItemKey(item)));
    onDecision?.(outcome);
    window.dispatchEvent(new Event("opening:reviews-changed"));
  }
  const refreshButton = state.kind !== "loggedOut" && state.kind !== "loading" ? <button type="button" onClick={() => void refresh()} className={secondaryButtonClass}><RefreshCw size={14} aria-hidden="true" />重新读取</button> : null;
  return <section className={embedded ? "w-full bg-surface" : "flex h-full min-h-0 w-full flex-col bg-surface"} aria-label={embedded ? "待确认建议" : undefined}>
    {embedded ? <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4"><p className="text-xs text-text-3">选择要加入学习安排的任务，或决定助理可以记住什么。</p>{refreshButton}</div> : <PageHeader title={state.kind === "ready" && pendingCount ? `待确认建议 · ${pendingCount} 项` : "待确认建议"} action={<div className="flex flex-wrap gap-2">{refreshButton}<Link href="/opening/today" className={secondaryButtonClass}>返回开始</Link></div>} />}
    <div className={embedded ? "px-5 py-4" : "min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7"}>
    {state.kind === "loading" ? <p role="status" className="text-sm text-text-2">正在读取待审核建议…</p> : null}
    {state.kind === "loggedOut" ? <><EmptyState title="尚未登录" description="登录后查看属于你的待审核建议。" /><Link href="/login" className={secondaryButtonClass}>去登录</Link></> : null}
    {state.kind === "error" ? <div role="alert" className="space-y-2"><p className="text-sm text-danger">建议暂时无法读取：{state.message}</p><p className="text-xs text-text-2">读取失败不表示没有待审核建议；已有输入不会被清空。</p></div> : null}
    {state.kind === "ready" && state.items.length === 0 ? <p className="text-sm text-text-3">目前没有需要确认的建议。</p> : null}
    {state.kind !== "loggedOut" && state.items.length > 0 ? <ul className="mx-auto max-w-4xl divide-y divide-line border-y border-line" aria-label="待审核建议">{state.items.map((item) => <ReviewCard key={reviewItemKey(item)} item={item} actions={actions} conversationApi={conversationApi} onDecision={outcome => decided(item, outcome)} />)}</ul> : null}
    </div>
  </section>;
}
