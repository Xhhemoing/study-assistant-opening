"use client";

import { ArrowLeft, Check, Clock3, Eye, Lightbulb, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ErrorCause, PracticeItem } from "@aistudy/contracts";
import { useRouter } from "next/navigation";
import { useStudyProvider } from "../../lib/data/react";
import { isPracticeAnswerCorrect } from "@aistudy/domain";
import {
  createPracticePlayerState,
  getSubmissionIssue,
  type PracticePlayerState,
  type SubmissionIssue,
} from "./practice-player-model";
import { AnswerInput } from "./answer-input";
import { VerdictPanel } from "./verdict-panel";

interface PracticePlayerProps {
  itemId: string;
  context?: { date?: string; taskId?: string };
}

function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatDuration(value: number): string {
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function getIssueMessage(issue: SubmissionIssue | null): string {
  if (issue === "answer-required") return "请先完成作答。";
  if (issue === "verdict-required") return "请先检查答案。";
  return "";
}

function PlayerSkeleton() {
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8" aria-busy="true"><div className="h-5 w-28 animate-pulse rounded bg-surface-2" /><div className="space-y-3 border-b border-line pb-6"><div className="h-8 w-3/4 animate-pulse rounded bg-surface-2" /><div className="h-4 w-1/2 animate-pulse rounded bg-surface-2" /></div><div className="h-48 animate-pulse rounded-lg bg-surface-2" /></div>;
}

export function PracticePlayer({ itemId, context }: PracticePlayerProps) {
  const provider = useStudyProvider();
  const router = useRouter();
  const [item, setItem] = useState<PracticeItem | null>(null);
  const [state, setState] = useState<PracticePlayerState>(createPracticePlayerState);
  const [showAnswer, setShowAnswer] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const startedAt = useRef(Date.now());
  const idempotencyKey = useRef(createIdempotencyKey());

  useEffect(() => {
    if (!provider) return;
    let active = true;
    setLoading(true);
    setLoadError("");
    provider.getPracticeItem(itemId).then((nextItem) => {
      if (!active) return;
      setItem(nextItem);
      setState(createPracticePlayerState());
      setShowAnswer(false);
      startedAt.current = Date.now();
      if (!nextItem) setLoadError("找不到这道练习题，可能已经被移除。");
    }).catch(() => {
      if (active) setLoadError("练习题加载失败，请重试。");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [itemId, provider, retryToken]);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt.current), 1000);
    return () => window.clearInterval(timer);
  }, []);

  function updateAnswer(answer: string) {
    setState((current) => current.phase === "answering" ? { ...current, answer } : current);
    setSubmitError("");
  }

  function revealHint() {
    if (!item || state.phase !== "answering" || state.hintCount >= Math.min(3, item.hints.length)) return;
    setState((current) => ({ ...current, hintCount: current.hintCount + 1 }));
  }

  function revealAnswer() {
    if (state.phase === "submitting" || state.phase === "submitted") return;
    setShowAnswer(true);
    setState((current) => ({ ...current, assisted: true }));
  }

  function checkAnswer() {
    if (!item || state.phase !== "answering") return;
    if (!state.answer.trim()) {
      setSubmitError("请先完成作答。");
      return;
    }
    setSubmitError("");
    setState((current) => ({
      ...current,
      phase: "verdict",
      verdict: isPracticeAnswerCorrect(item, current.answer),
      confidence: null,
      errorCause: null,
    }));
  }

  function reviseAnswer() {
    setSubmitError("");
    setState((current) => ({ ...current, phase: "answering", verdict: null, confidence: null, errorCause: null }));
  }

  async function submit() {
    if (!provider || !item || state.phase === "submitting" || state.phase === "submitted") return;
    const issue = getSubmissionIssue(state);
    if (issue) {
      setSubmitError(getIssueMessage(issue));
      return;
    }
    setSubmitError("");
    setState((current) => ({ ...current, phase: "submitting" }));
    try {
      const result = await provider.submitAttempt({
        practiceItemId: item.id,
        answer: state.answer,
        durationMs: Math.max(0, Date.now() - startedAt.current),
        hintCount: state.hintCount,
        confidence: state.confidence as number,
        errorCause: state.errorCause,
        assisted: state.assisted,
        idempotencyKey: idempotencyKey.current,
      });
      const params = new URLSearchParams({ event: result.event.id });
      if (context?.taskId) params.set("taskId", context.taskId);
      if (context?.date) params.set("date", context.date);
      setState((current) => ({ ...current, phase: "submitted" }));
      router.push(`/learn/practice/${encodeURIComponent(item.id)}/result?${params.toString()}`);
    } catch {
      setState((current) => ({ ...current, phase: "verdict" }));
      setSubmitError("作答提交失败，请保留当前内容后重试。");
    }
  }

  if (loading || !provider) return <PlayerSkeleton />;
  if (loadError || !item) {
    return <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"><Link className="inline-flex w-fit items-center gap-2 text-sm text-text-dim hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link><section className="space-y-4 border-y border-line py-8" role="alert"><p className="text-sm text-danger">{loadError || "找不到这道练习题。"}</p><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setRetryToken((value) => value + 1)} type="button"><RefreshCw aria-hidden="true" size={16} />重试</button></section></main>;
  }

  const issue = getSubmissionIssue(state);
  const hintLimit = Math.min(3, item.hints.length);
  const isAnswering = state.phase === "answering";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-8 sm:px-6 lg:px-8">
      <header className="space-y-4 border-b border-line pb-6">
        <Link className="inline-flex items-center gap-2 text-sm text-text-dim transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/learn"><ArrowLeft aria-hidden="true" size={16} />返回学习空间</Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div className="space-y-2"><p className="text-xs text-text-dim">练习 · {item.estimatedMinutes} 分钟</p><h1 className="text-2xl font-semibold tracking-[-0.02em] text-text">检验你的理解</h1></div><div className="inline-flex items-center gap-2 text-sm tabular-nums text-text-dim" aria-label={`已用时 ${formatDuration(elapsedMs)}`}><Clock3 aria-hidden="true" size={16} />{formatDuration(elapsedMs)}</div></div>
      </header>

      <section className="space-y-6" aria-labelledby="practice-stem-heading">
        <div className="flex items-start gap-3"><span className="mt-0.5 inline-grid size-8 shrink-0 place-items-center rounded-full bg-primary/15 text-primary" aria-hidden="true"><Check size={16} /></span><h2 className="text-lg font-semibold leading-7 text-text" id="practice-stem-heading">{item.stem}</h2></div>
        <AnswerInput answer={state.answer} disabled={!isAnswering} item={item} onChange={updateAnswer} onSubmit={checkAnswer} />
      </section>

      {state.hintCount > 0 ? <ol className="space-y-2 border-y border-line py-4 text-sm leading-6 text-text-dim" aria-label="已查看的提示">{item.hints.slice(0, state.hintCount).map((hint, index) => <li className="flex gap-3" key={`${index}-${hint}`}><span className="shrink-0 font-semibold text-primary">提示 {index + 1}</span><span>{hint}</span></li>)}</ol> : null}
      {showAnswer ? <p className="border-y border-line py-4 text-sm leading-6 text-text"><span className="font-semibold">参考答案：</span>{item.answer}</p> : null}

      {isAnswering ? <div className="flex flex-wrap gap-2 border-t border-line pt-5"><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text-dim transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={state.hintCount >= hintLimit} onClick={revealHint} type="button"><Lightbulb aria-hidden="true" size={16} />看提示 <span className="text-xs">{state.hintCount}/{hintLimit}</span></button><button className="inline-flex min-h-10 items-center gap-2 rounded-md border border-line px-3 text-sm text-text-dim transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={revealAnswer} type="button"><Eye aria-hidden="true" size={16} />看答案</button><button className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-ink transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={checkAnswer} type="button"><Check aria-hidden="true" size={16} />检查答案</button></div> : null}
      {submitError ? <p className="text-sm text-danger" role="alert">{submitError}</p> : null}

      {state.verdict !== null ? <VerdictPanel assisted={state.assisted} confidence={state.confidence} correct={state.verdict} errorCause={state.errorCause} expectedAnswer={item.answer} issue={issue} onConfidenceChange={(confidence) => setState((current) => ({ ...current, confidence }))} onErrorCauseChange={(errorCause: ErrorCause) => setState((current) => ({ ...current, errorCause }))} onRevealAnswer={revealAnswer} onSubmit={() => void submit()} showAnswer={showAnswer} submitting={state.phase === "submitting"} /> : null}
      {state.phase === "verdict" ? <button className="inline-flex w-fit items-center gap-2 text-sm text-text-dim underline-offset-4 hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" onClick={reviseAnswer} type="button">重新作答</button> : null}
      {state.phase === "submitted" ? <p className="inline-flex items-center gap-2 text-sm text-success" role="status"><LoaderCircle aria-hidden="true" size={16} />正在打开结果...</p> : null}
    </main>
  );
}
