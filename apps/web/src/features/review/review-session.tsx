"use client";

import { ui } from "../opening/design/ui";
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
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewGrade } from "@aistudy/contracts";
import type { LucideIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useStudyProvider } from "../../lib/data/react";
import {
  applyReviewGrade,
  createReviewSessionState,
  flipReviewCard,
  getReviewProgress,
  resolveReviewGradeIdentity,
  reviewGradeForKey,
  type ReviewGradeIdentity,
  type ReviewSessionState,
} from "./review-session-model";

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8" aria-busy="true"><div className="h-5 w-28  rounded bg-zinc-100" /><div className="h-8 w-1/3  rounded bg-zinc-100" /><div className="h-64  rounded-lg bg-zinc-100" /></div>;
}

function ReviewEmptyState() {
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8"><Link className="inline-flex w-fit items-center gap-2 text-sm text-zinc-500 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><section className="space-y-4 border-y border-zinc-200 py-10"><h1 className="text-xl font-semibold text-zinc-900">今天没有到期复习</h1><p className="text-sm leading-7 text-zinc-500">可以继续今日计划，或从自由探索中沉淀新的复习卡片。</p><div className="flex flex-wrap gap-3"><Link className={ui.primary} href="/learn">今日计划</Link><Link className={ui.secondary} href="/explore">自由探索</Link></div></section></main>;
}

function ReviewFinished({ completed, total, nextDueAt }: { completed: number; total: number; nextDueAt: string | null }) {
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8"><header className="space-y-3 border-b border-zinc-200 pb-4"><p className="text-xs text-zinc-500">复习完成</p><h1 className="text-xl font-semibold text-zinc-900">这组卡片已经处理完毕</h1><p className="text-sm leading-7 text-zinc-500">本次完成 {completed}/{total} 张卡片。</p></header><section className="space-y-3 border-y border-zinc-200 py-6"><p className="text-sm text-zinc-500">下一次复习时间</p><p className="text-base font-semibold text-zinc-900">{nextDueAt ? formatDueAt(nextDueAt) : "等待新的复习安排"}</p></section><Link className={ui.primary} href="/learn">返回今日计划</Link></main>;
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
  const gradeIdentity = useRef<ReviewGradeIdentity | null>(null);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    setLoading(true);
    setError("");
    provider.listDueCards(undefined, { mode: requestedCardId ? "self-selected" : "auto" })
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
    const identity = resolveReviewGradeIdentity(
      gradeIdentity.current,
      current.card.id,
      grade,
      createIdempotencyKey,
    );
    gradeIdentity.current = identity;
    try {
      const nextState = await provider.gradeCard(current.card.id, grade, {
        idempotencyKey: identity.key,
      });
      gradeIdentity.current = null;
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
  if (error && session.queue.length === 0) return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8"><Link className="inline-flex w-fit items-center gap-2 text-sm text-zinc-500 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><section className="space-y-4 border-y border-zinc-200 py-8" role="alert"><p className="text-sm text-red-700">{error}</p><button className={ui.secondary} onClick={() => setRetryToken((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button></section></main>;
  if (session.queue.length === 0) return <ReviewEmptyState />;
  if (session.status === "finished") return <ReviewFinished completed={session.completed} nextDueAt={nextDueAt} total={session.queue.length} />;

  const current = session.current;
  if (!current) return <ReviewEmptyState />;
  const progress = getReviewProgress(session);
  return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
    <header className="flex items-end justify-between gap-4 border-b border-zinc-200 pb-4"><div className="space-y-2"><Link className="inline-flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><h1 className="text-xl font-semibold text-zinc-900">复习卡片</h1></div><span className="text-sm tabular-nums text-zinc-500">第 {progress.current}/{progress.total} 张</span></header>
    <progress aria-label={`复习进度 ${progress.completed}/${progress.total}`} className="h-2 w-full accent-emerald-600" max={progress.total} value={progress.completed} />
    {error ? <p className="text-sm text-red-700" role="alert">{error}</p> : null}
    <section className="grid gap-5" aria-live="polite"><button aria-label={session.flipped ? "显示卡片正面" : "显示卡片背面"} aria-pressed={session.flipped} className="grid min-h-[18rem] gap-4 rounded-md border-y border-x-0 border-zinc-200 bg-white p-6 text-left transition-colors duration-150 motion-reduce:transition-none hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 sm:p-6" onClick={() => setSession((currentSession) => flipReviewCard(currentSession))} type="button"><span className="text-xs font-semibold  text-emerald-700">{session.flipped ? "背面" : "正面"}</span><span className="self-center whitespace-pre-wrap text-sm font-medium leading-7 text-zinc-900">{session.flipped ? current.card.back : current.card.front}</span><span className="inline-flex items-center gap-2 text-xs text-zinc-500">{session.flipped ? <RotateCcw aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={15} />}{session.flipped ? "查看正面" : "显示背面"}</span></button>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{gradeOptions.map(({ grade, label, icon: Icon }, index) => <button aria-keyshortcuts={String(index + 1)} className={ui.secondary} disabled={!session.flipped || grading} key={grade} onClick={() => void gradeCard(grade)} type="button">{grading && session.flipped ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={16} /> : <Icon aria-hidden="true" size={16} />}{label}</button>)}</div>
    </section>
  </main>;
}
