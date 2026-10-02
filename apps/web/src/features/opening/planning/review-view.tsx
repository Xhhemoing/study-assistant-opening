"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { EmptyState, PageHeader, secondaryButtonClass } from "../design/ui";
import { createReviewActions, loadReviewItems, retainUnconfirmedReviews, type ReviewApi } from "./review-service";
import { ReviewCard } from "./review-card";
import { reviewItemKey, type ReviewItem } from "./review-types";

type ReadState = { kind: "loading" | "ready" | "error" | "loggedOut"; items: ReviewItem[]; message?: string };
export function ReviewView({ api: supplied }: { api?: ReviewApi }) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const actions = useMemo(() => createReviewActions(api), [api]);
  const [state, setState] = useState<ReadState>({ kind: "loading", items: [] });
  const refresh = useCallback(async () => {
    try {
      const items = await loadReviewItems(api);
      setState((current) => ({ kind: "ready", items: retainUnconfirmedReviews(current.items, items, actions.pending) }));
    }
    catch (error) { setState((current) => ({ ...current, kind: error instanceof OpeningApiError && error.status === 401 ? "loggedOut" : "error", message: error instanceof Error ? error.message : "暂时无法读取建议" })); }
  }, [api, actions]);
  useEffect(() => { void refresh(); }, [refresh]);
  return <section className="flex h-full min-h-0 w-full flex-col bg-white">
    <PageHeader title={state.kind === "ready" && state.items.length ? `审核建议 · ${state.items.length} 项` : "审核建议"} description="逐项决定任务、记忆和补测。模型建议不是事实，稍后处理也不影响继续学习。" action={<div className="flex flex-wrap gap-2">{state.kind !== "loggedOut" && state.kind !== "loading" ? <button type="button" onClick={() => void refresh()} className={secondaryButtonClass}><RefreshCw size={14} aria-hidden="true" />重新读取</button> : null}<Link href="/opening/today" className={secondaryButtonClass}>返回今天</Link></div>} />
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
    {state.kind === "loading" ? <p role="status" className="text-sm text-zinc-600">正在读取待审核建议…</p> : null}
    {state.kind === "loggedOut" ? <><EmptyState title="尚未登录" description="登录后查看属于你的待审核建议。" /><Link href="/login" className={secondaryButtonClass}>去登录</Link></> : null}
    {state.kind === "error" ? <div role="alert" className="space-y-2"><p className="text-sm text-red-700">建议暂时无法读取：{state.message}</p><p className="text-xs text-zinc-500">读取失败不表示没有待审核建议；已有输入不会被清空。</p></div> : null}
    {state.kind === "ready" && state.items.length === 0 ? <EmptyState title="没有待审核建议" description="目前没有需要决定的任务、记忆或补测。可以返回今天继续学习。" /> : null}
    {state.kind !== "loggedOut" && state.items.length > 0 ? <ul className="mx-auto max-w-4xl divide-y divide-zinc-200 border-y border-zinc-200" aria-label="待审核建议">{state.items.map((item) => <ReviewCard key={reviewItemKey(item)} item={item} actions={actions} />)}</ul> : null}
    </div>
  </section>;
}
