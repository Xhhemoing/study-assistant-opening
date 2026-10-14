"use client";
import { useEffect, useMemo, useState } from "react";
import type { SourceRecord } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { ReviewCard } from "../planning/review-card";
import { createReviewActions, retainUnconfirmedReviews } from "../planning/review-service";
import { reviewItems, reviewItemKey, type ReviewItem } from "../planning/review-types";
import { chatCandidateItems } from "./chat-suggestions-model";

export function ChatSuggestions({ api, turnIds, sources }: { api: OpeningApi; turnIds: string[]; sources: SourceRecord[] }) {
  const [items, setItems] = useState<ReviewItem[]>([]), [error, setError] = useState("");
  const actions = useMemo(() => createReviewActions(api), [api]);
  const key = turnIds.join(",");
  useEffect(() => {
    let active = true;
    const ids = key.split(",").filter(Boolean);
    if (!ids.length) { setItems([]); return; }
    void api.listCandidates().then(rows => {
      if (active) {
        setItems(old => retainUnconfirmedReviews(old, reviewItems(chatCandidateItems(rows, ids), [], sources), item => actions.pending(item)));
        setError("");
      }
    }).catch(() => { if (active) setError("任务建议暂时无法读取；对话仍可继续，可在建议审核页重新读取。"); });
    return () => { active = false; };
  }, [api, key, sources, actions]);
  if (!items.length && !error) return null;
  return <details className="mx-5 mb-2 max-h-80 overflow-y-auto rounded-lg border border-zinc-200 p-3">
    <summary className="cursor-pointer text-sm font-medium text-zinc-800">本次对话的任务与记忆建议（{items.length}）</summary>
    {error ? <p role="status" className="mt-2 text-xs text-amber-800">{error}</p> : null}
    <ul className="divide-y divide-zinc-200">{items.map(item => <ReviewCard key={reviewItemKey(item)} item={item} actions={actions} />)}</ul>
  </details>;
}
