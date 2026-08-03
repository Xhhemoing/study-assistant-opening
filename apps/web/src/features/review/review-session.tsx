"use client";

import {
  ArrowLeft,
  Check,
  CircleHelp,
  Eye,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReviewGrade } from "@aistudy/contracts";
import type { LucideIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useStudyProvider } from "../../lib/data/react";
import {
  applyReviewGrade,
  createReviewSessionState,
  flipReviewCard,
  getReviewProgress,
  reviewGradeForKey,
  type ReviewSessionState,
} from "./review-session-model";

const gradeOptions: Array<{ grade: ReviewGrade; label: string; icon: LucideIcon }> = [
  { grade: "again", label: "忘记", icon: RotateCcw },
  { grade: "hard", label: "困难", icon: CircleHelp },
  { grade: "good", label: "良好", icon: Check },
  { grade: "easy", label: "简单", icon: Sparkles },
];

function formatDueAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function SessionSkeleton() {
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8" aria-busy="true"><div className="h-5 w-28 animate-pulse rounded bg-surface-2" /><div className="h-8 w-1/3 animate-pulse rounded bg-surface-2" /><div className="h-64 animate-pulse rounded-xl bg-surface-2" /></div>;
}

function ReviewEmptyState() {
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><Link className="inline-flex w-fit items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><section className="space-y-4 border-y border-line py-10"><h1 className="text-2xl font-semibold text-text">今天没有到期复习</h1><p className="text-sm leading-6 text-text-dim">可以继续今日计划，或从自由探索中沉淀新的复习卡片。</p><div className="flex flex-wrap gap-3"><Link className="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn">今日计划</Link><Link className="inline-flex min-h-10 items-center rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/explore">自由探索</Link></div></section></main>;
}

function ReviewFinished({ completed, total, nextDueAt }: { completed: number; total: number; nextDueAt: string | null }) {
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><header className="space-y-3 border-b border-line pb-6"><p className="text-xs text-text-dim">复习完成</p><h1 className="text-2xl font-semibold text-text">这组卡片已经处理完毕</h1><p className="text-sm leading-6 text-text-dim">本次完成 {completed}/{total} 张卡片。</p></header><section className="space-y-3 border-y border-line py-6"><p className="text-sm text-text-dim">下一次复习时间</p><p className="text-base font-semibold text-text">{nextDueAt ? formatDueAt(nextDueAt) : "等待新的复习安排"}</p></section><Link className="inline-flex min-h-10 w-fit items-center rounded-md bg-primary px-3 text-sm font-semibold text-ink hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn">返回今日计划</Link></main>;
}

export function ReviewSession() {
  const provider = useStudyProvider();
  const searchParams = useSearchParams();
  const requestedCardId = searchParams.get("cardId") ?? undefined;
  const [session, setSession] = useState<ReviewSessionState>(() => createReviewSessionState([]));
  const [loading, setLoading] = useState(true);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState("");
  const [nextDueAt, setNextDueAt] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    setLoading(true);
    setError("");
    provider.listDueCards()
      .then((queue) => {
        if (active) setSession(createReviewSessionState(queue, requestedCardId));
      })
      .catch(() => {
        if (active) setError("复习队列加载失败，请重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [provider, requestedCardId, retryToken]);

  const gradeCard = useCallback(async (grade: ReviewGrade) => {
    const current = session.current;
    if (!provider || !current || !session.flipped || grading) return;
    setGrading(true);
    setError("");
    try {
      const nextState = await provider.gradeCard(current.card.id, grade);
      setNextDueAt((existing) => !existing || nextState.dueAt < existing ? nextState.dueAt : existing);
      setSession((currentSession) => applyReviewGrade(currentSession, grade));
    } catch {
      setError("评分保存失败，请保持当前卡片并重试。");
    } finally {
      setGrading(false);
    }
  }, [grading, provider, session.current, session.flipped]);

  useEffect(() => {
    if (loading || !provider || session.status !== "active") return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setSession((current) => flipReviewCard(current));
        return;
      }
      const grade = reviewGradeForKey(event.key);
      if (grade) {
        event.preventDefault();
        void gradeCard(grade);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [gradeCard, loading, provider, session.status]);

  if (loading || !provider) return <SessionSkeleton />;
  if (error && session.queue.length === 0) return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><Link className="inline-flex w-fit items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><section className="space-y-4 border-y border-line py-8" role="alert"><p className="text-sm text-danger">{error}</p><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setRetryToken((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button></section></main>;
  if (session.queue.length === 0) return <ReviewEmptyState />;
  if (session.status === "finished") return <ReviewFinished completed={session.completed} nextDueAt={nextDueAt} total={session.queue.length} />;

  const current = session.current;
  if (!current) return <ReviewEmptyState />;
  const progress = getReviewProgress(session);
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-8 sm:px-6 lg:px-8">
    <header className="flex items-end justify-between gap-4 border-b border-line pb-6"><div className="space-y-2"><Link className="inline-flex items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><h1 className="text-2xl font-semibold text-text">复习卡片</h1></div><span className="text-sm tabular-nums text-text-dim">第 {progress.current}/{progress.total} 张</span></header>
    <progress aria-label={`复习进度 ${progress.completed}/${progress.total}`} className="h-2 w-full accent-primary" max={progress.total} value={progress.completed} />
    {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    <section className="grid gap-5" aria-live="polite"><button aria-label={session.flipped ? "显示卡片正面" : "显示卡片背面"} aria-pressed={session.flipped} className="grid min-h-[18rem] gap-4 rounded-xl border border-line bg-surface p-6 text-left shadow-xl shadow-black/15 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:p-10" onClick={() => setSession((currentSession) => flipReviewCard(currentSession))} type="button"><span className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{session.flipped ? "背面" : "正面"}</span><span className="self-center whitespace-pre-wrap text-xl font-semibold leading-9 text-text">{session.flipped ? current.card.back : current.card.front}</span><span className="inline-flex items-center gap-2 text-xs text-text-dim">{session.flipped ? <RotateCcw aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={15} />}{session.flipped ? "查看正面" : "显示背面"}</span></button>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{gradeOptions.map(({ grade, label, icon: Icon }, index) => <button aria-keyshortcuts={String(index + 1)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-line px-3 text-sm font-semibold text-text transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={!session.flipped || grading} key={grade} onClick={() => void gradeCard(grade)} type="button">{grading && session.flipped ? <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> : <Icon aria-hidden="true" size={16} />}{label}</button>)}</div>
    </section>
  </main>;
}
