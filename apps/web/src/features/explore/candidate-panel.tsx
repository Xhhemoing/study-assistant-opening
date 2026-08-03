"use client";

import { BookOpen, CreditCard, HelpCircle, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import type { PromotionCandidate } from "@aistudy/contracts";
import { createEditorApi } from "../editor/editor-api";
import { useStudyProvider } from "../../lib/data/react";
import { buildCandidateNoteBlocks, candidateKindLabel, pendingCandidates } from "./candidate-panel-model";

type CandidateAction = "note" | "card" | "question";

export function CandidatePanel({
  explorationTitle,
  candidates,
  onCandidateChange,
}: {
  explorationTitle: string;
  candidates: PromotionCandidate[];
  onCandidateChange: (candidate: PromotionCandidate) => void;
}) {
  const provider = useStudyProvider();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pending = pendingCandidates(candidates);

  if (pending.length === 0) return null;

  async function promote(candidate: PromotionCandidate, action: CandidateAction) {
    if (!provider || busyKey) return;
    const key = `${candidate.id}:${action}`;
    setBusyKey(key);
    setError("");
    try {
      let targetId: string;
      if (action === "note") {
        const document = await createEditorApi().createDocument({
          title: candidate.title,
          lifecycle: "candidate",
          blocks: buildCandidateNoteBlocks(candidate, explorationTitle),
        });
        targetId = document.id;
      } else if (action === "card") {
        const card = await provider.createReviewCard({
          front: candidate.title,
          back: candidate.body,
          tags: ["探索"],
        });
        targetId = card.id;
      } else {
        const item = await provider.createPracticeItem({
          stem: candidate.title,
          answer: candidate.body,
          hints: ["先用自己的话回答，再检查关键条件。"],
        });
        targetId = item.id;
      }
      onCandidateChange(await provider.setCandidateStatus(candidate.id, "promoted", targetId));
    } catch {
      setError("沉淀失败，请稍后重试。候选内容仍会保留。");
    } finally {
      setBusyKey(null);
    }
  }

  async function reject(candidate: PromotionCandidate) {
    if (!provider || busyKey) return;
    setBusyKey(`${candidate.id}:reject`);
    setError("");
    try {
      onCandidateChange(await provider.setCandidateStatus(candidate.id, "rejected"));
    } catch {
      setError("暂时无法拒绝这个候选，请稍后重试。");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="space-y-4 border-y border-line py-5" aria-label="候选沉淀">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text">候选沉淀</h2>
          <p className="mt-1 text-xs text-text-dim">只处理你明确选中的内容。</p>
        </div>
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">{pending.length} 条待处理</span>
      </div>
      <div className="space-y-3">
        {pending.map((candidate) => {
          const active = busyKey?.startsWith(`${candidate.id}:`) ?? false;
          return (
            <article className="space-y-3 rounded-lg border border-line bg-surface p-4" key={candidate.id}>
              <div className="flex items-start gap-3">
                <BookOpen aria-hidden="true" className="mt-0.5 shrink-0 text-primary" size={17} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words text-sm font-semibold text-text">{candidate.title}</h3>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-dim">{candidateKindLabel(candidate.kind)}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-dim">{candidate.body}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pl-8">
                <button className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={!provider || busyKey !== null} type="button" onClick={() => void promote(candidate, "note")}>
                  {active && busyKey?.endsWith(":note") ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : <BookOpen aria-hidden="true" size={14} />}转笔记
                </button>
                <button className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line px-3 text-xs font-semibold text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={!provider || busyKey !== null} type="button" onClick={() => void promote(candidate, "card")}>
                  {active && busyKey?.endsWith(":card") ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : <CreditCard aria-hidden="true" size={14} />}转卡片
                </button>
                <button className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-line px-3 text-xs font-semibold text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={!provider || busyKey !== null} type="button" onClick={() => void promote(candidate, "question")}>
                  {active && busyKey?.endsWith(":question") ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : <HelpCircle aria-hidden="true" size={14} />}转题目
                </button>
                <button className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-transparent px-3 text-xs text-text-dim hover:border-line hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={!provider || busyKey !== null} type="button" onClick={() => void reject(candidate)}>
                  {active && busyKey?.endsWith(":reject") ? <LoaderCircle aria-hidden="true" className="animate-spin" size={14} /> : <X aria-hidden="true" size={14} />}拒绝
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
    </section>
  );
}
