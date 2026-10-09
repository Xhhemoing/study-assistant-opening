"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { ReviewCard } from "./review-card";
import { createReviewActions, retainUnconfirmedReviews, type ReviewApi } from "./review-service";
import { reviewItemKey, reviewItems, type ReviewItem } from "./review-types";

/** Load only pending retest proposals (no assistant/memory candidates). */
export async function loadRetestProposals(api: Pick<ReviewApi, "listRetestCandidates" | "listSources">): Promise<ReviewItem[]> {
  const [retests, sources] = await Promise.all([api.listRetestCandidates(), api.listSources()]);
  return reviewItems([], retests, sources);
}

type ReadState = { kind: "loading" | "ready" | "error" | "loggedOut" | "empty"; items: ReviewItem[]; message?: string };

/**
 * Inline today-page retest proposals. Reuses ReviewCard + createReviewActions
 * (single request per action, no automatic retry).
 */
export function RetestProposals({ api: supplied, onChanged }: { api?: ReviewApi; onChanged?: () => void }) {
  const api = useMemo(() => supplied ?? createOpeningApi(), [supplied]);
  const baseActions = useMemo(() => createReviewActions(api), [api]);
  const [state, setState] = useState<ReadState>({ kind: "loading", items: [] });
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const refresh = useCallback(async () => {
    try {
      const items = await loadRetestProposals(api);
      setState((current) => {
        const next = retainUnconfirmedReviews(current.items, items, baseActions.pending);
        if (!next.length) return { kind: "empty", items: [] };
        return { kind: "ready", items: next };
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        kind: error instanceof OpeningApiError && error.status === 401 ? "loggedOut" : "error",
        message: error instanceof Error ? error.message : "暂时无法读取补测提议",
      }));
    }
  }, [api, baseActions]);

  const actions = useMemo(() => ({
    pending: baseActions.pending,
    async submit(...args: Parameters<typeof baseActions.submit>) {
      const outcome = await baseActions.submit(...args);
      onChangedRef.current?.();
      return outcome;
    },
  }), [baseActions]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (state.kind === "loading") return <p className="border-b border-zinc-200 px-4 py-3 text-[11px] text-zinc-500" role="status">正在读取补测提议…</p>;
  if (state.kind === "loggedOut" || state.kind === "empty") return null;
  if (state.kind === "error") {
    return <div className="space-y-2 border-b border-amber-200 bg-amber-50 px-4 py-3" role="alert">
      <p className="text-[11px] leading-5 text-amber-900">补测提议暂时无法读取：{state.message}</p>
      <button type="button" className="text-[11px] font-medium text-amber-950 underline" onClick={() => void refresh()}>重新读取</button>
    </div>;
  }

  return <section className="border-b border-zinc-200 bg-white" aria-label="待审核补测提议">
    <div className="px-4 pb-1 pt-3"><h3 className="text-[11px] font-semibold text-zinc-500">待审核补测 · {state.items.length}</h3>
      <p className="mt-0.5 text-[11px] leading-5 text-zinc-500">接受后才会加入任务；忽略不会自动重试。</p></div>
    <ul className="divide-y divide-zinc-200 px-4">{state.items.map((item) => (
      <ReviewCard key={reviewItemKey(item)} item={item} actions={actions} />
    ))}</ul>
  </section>;
}
