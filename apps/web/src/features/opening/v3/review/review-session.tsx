"use client";
import { useState, type ReactNode } from "react";
import { ui } from "../ui/controls";
import { ArrowLeft } from "lucide-react";
import { TransitionLink } from "../motion/view-transition";
import { TopBar } from "../shell/top-bar";
import { ProgressSteps } from "../ui/progress-steps";

export type ReviewItem = { id: string; kind: "card" | "redo" | "variant"; prompt: ReactNode; answer: ReactNode; source: string };
export type ReviewRating = "again" | "hard" | "good" | "easy";
const RATINGS: { value: ReviewRating; label: string }[] = [{ value: "again", label: "没想起" }, { value: "hard", label: "很吃力" }, { value: "good", label: "想起来了" }, { value: "easy", label: "很轻松" }];
const KIND: Record<ReviewItem["kind"], string> = { card: "卡片回忆", redo: "原题重做", variant: "未见变式" };

type Props = {
  items: ReviewItem[];
  /** 评分写入现有复习服务；下次时间由服务计算，不在前端写死 */
  onRate: (item: ReviewItem, rating: ReviewRating) => Promise<void>;
  backHref: string;
  done: ReactNode;
};

/**
 * T12 复习会话：回忆 → 揭示答案 → 自评 → 下一项 → 结束。
 * 动效：题目卡逐项横向滑入；答案以模糊淡入揭示；评分按钮错开出现；进度分段推进。
 */
export function ReviewSession({ items, onRate, backHref, done }: Props) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const item = items[index];

  async function rate(rating: ReviewRating) {
    if (!item) return;
    setSaving(true); setError(false);
    try { await onRate(item, rating); setRevealed(false); setIndex(index + 1); }
    catch { setError(true); }
    finally { setSaving(false); }
  }

  return (
    <div data-scroll-root className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <TopBar leading={<TransitionLink href={backHref} direction="back" aria-label="结束复习" className={ui.icon}><ArrowLeft size={18} aria-hidden="true" /></TransitionLink>}
        title={<h1 className="text-ui font-medium">复习</h1>}
        actions={<span className="rounded-pill glass px-3 py-1 text-meta tabular-nums text-text-2">{Math.min(index + 1, items.length)} / {items.length}</span>}
        progress={<ProgressSteps value={index} max={items.length} label="本次复习进度" />} />
      <div className="py-8">
        <div className="content-grid">
          {!item ? <div className="motion-safe:animate-slide-in">{done}</div> : (
            <article key={item.id} className="space-y-4 motion-safe:animate-slide-in">
              <p className="text-cap text-text-2">{KIND[item.kind]} · {item.source}</p>
              <div className="prose-reading text-read-lg">{item.prompt}</div>
              {revealed
                ? <div className="rounded-panel border border-line bg-surface p-5 prose-reading shadow-card motion-safe:animate-text-in">{item.answer}</div>
                : <button type="button" className={`${ui.secondary} w-full`} onClick={() => setRevealed(true)}>显示答案</button>}
              {revealed && <div role="group" aria-label="这次回忆得怎么样" className="grid grid-cols-2 gap-2 sm:grid-cols-4 motion-safe:stagger">
                {RATINGS.map(rating => <button key={rating.value} type="button" disabled={saving} onClick={() => rate(rating.value)} className={rating.value === "good" ? ui.primary : ui.secondary}>{rating.label}</button>)}
              </div>}
              {error && <p role="alert" className="text-meta text-danger motion-safe:animate-text-in">没有记录上，再点一次</p>}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
