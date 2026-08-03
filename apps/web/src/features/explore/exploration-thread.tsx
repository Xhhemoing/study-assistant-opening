"use client";

import { ArrowLeft, Bot, Send, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AIRole, ChatTurn, PromotionCandidate } from "@aistudy/contracts";
import { useStudyProvider } from "../../lib/data/react";
import { AI_ROLE_OPTIONS } from "../../lib/data/mock/mock-replies";
import {
  appendMessageTurns,
  getRoleLabel,
  shouldSendOnEnter,
} from "./exploration-thread-model";
import { CandidatePanel } from "./candidate-panel";

function formatCreatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function ThreadTurn({ turn }: { turn: ChatTurn }) {
  const user = turn.author === "user";
  return (
    <article className={`flex gap-3 ${user ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[min(42rem,88%)] gap-3 ${user ? "flex-row-reverse" : ""}`}>
        <span className={`mt-1 inline-grid size-8 shrink-0 place-items-center rounded-full ${user ? "bg-primary/15 text-primary" : "bg-surface-2 text-text-dim"}`}>
          {user ? <UserRound aria-hidden="true" size={16} /> : <Bot aria-hidden="true" size={16} />}
        </span>
        <div className={`min-w-0 space-y-1 ${user ? "text-right" : ""}`}>
          <div className={`flex items-center gap-2 text-xs text-text-dim ${user ? "justify-end" : ""}`}>
            <span>{user ? "你" : `AI · ${getRoleLabel(turn.aiRole ?? "explainer")}`}</span>
            <time dateTime={turn.createdAt}>{formatCreatedAt(turn.createdAt)}</time>
          </div>
          <p className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${user ? "bg-primary text-ink" : "border border-line bg-surface"}`}>
            {turn.content}
          </p>
          {turn.simulated ? <span className="text-[11px] text-text-dim">模拟回复</span> : null}
        </div>
      </div>
    </article>
  );
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8" aria-busy="true">
      <div className="h-5 w-28 animate-pulse rounded bg-surface-2" />
      <div className="space-y-3 border-b border-line pb-6">
        <div className="h-8 w-2/3 animate-pulse rounded bg-surface-2" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-surface-2" />
      </div>
      <div className="space-y-6">
        <div className="ml-auto h-20 w-2/3 animate-pulse rounded-2xl bg-surface-2" />
        <div className="h-24 w-3/4 animate-pulse rounded-2xl bg-surface-2" />
      </div>
    </div>
  );
}

export function ExplorationThread({ explorationId }: { explorationId: string }) {
  const provider = useStudyProvider();
  const [title, setTitle] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [candidates, setCandidates] = useState<PromotionCandidate[]>([]);
  const [role, setRole] = useState<AIRole>("explainer");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [sendError, setSendError] = useState("");
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!provider) return;
    let active = true;
    setLoading(true);
    setLoadError("");
    provider.getExploration(explorationId)
      .then((detail) => {
        if (!active) return;
        if (!detail) {
          setLoadError("找不到这个探索，可能已经被移除。");
          return;
        }
        setTitle(detail.exploration.title);
        setTurns(detail.turns);
        setCandidates(detail.candidates);
      })
      .catch(() => {
        if (active) setLoadError("探索内容加载失败，请重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [explorationId, provider, retryToken]);

  async function sendMessage() {
    const nextContent = content.trim();
    if (!provider || !title || !nextContent || sending) return;
    const startedAt = Date.now();
    setSending(true);
    setSendError("");
    setTyping(role !== "silent");
    try {
      const result = await provider.sendExplorationMessage(explorationId, nextContent, role);
      const remaining = role === "silent" ? 0 : Math.max(0, 600 - (Date.now() - startedAt));
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      setTurns((current) => appendMessageTurns(current, result));
      const candidate = result.candidate;
      if (candidate) setCandidates((current) => [...current, candidate]);
      setContent("");
    } catch {
      setSendError("消息发送失败，请保留内容后重试。");
    } finally {
      setSending(false);
      setTyping(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSendOnEnter(event.key, event.shiftKey)) return;
    event.preventDefault();
    void sendMessage();
  }

  function handleCandidateChange(candidate: PromotionCandidate) {
    setCandidates((current) => current.map((item) => item.id === candidate.id ? candidate : item));
  }

  if (loading || !provider) return <ThreadSkeleton />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <Link className="inline-flex w-fit items-center gap-2 text-sm text-text-dim transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" href="/explore">
        <ArrowLeft aria-hidden="true" size={16} />
        返回探索
      </Link>

      <header className="space-y-3 border-b border-line pb-6">
        <p className="text-xs text-text-dim">自由探索 · 对话线程</p>
        <h1 className="break-words text-2xl font-semibold tracking-[-0.02em] text-text">{title || "探索"}</h1>
        <p className="text-sm text-text-dim">保留原始问题，再决定哪些内容值得沉淀。</p>
      </header>

      {loadError ? (
        <section className="space-y-3 border-y border-line py-8" role="alert">
          <p className="text-sm text-danger">{loadError}</p>
          <button className="rounded-md border border-line px-3 py-2 text-sm text-text transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" type="button" onClick={() => setRetryToken((value) => value + 1)}>重试</button>
        </section>
      ) : (
        <>
          <section className="space-y-6" aria-label="探索对话" aria-live="polite">
            {turns.map((turn) => <ThreadTurn key={turn.id} turn={turn} />)}
            {typing ? <p className="text-xs text-text-dim" role="status">AI 正在整理回复...</p> : null}
            {turns.length === 0 && !typing ? <p className="border-y border-line py-10 text-center text-sm text-text-dim">从你的第一个问题开始。</p> : null}
          </section>

          <CandidatePanel
            candidates={candidates}
            explorationTitle={title}
            onCandidateChange={handleCandidateChange}
          />

          <form className="sticky bottom-4 space-y-3 rounded-xl border border-line bg-ink/95 p-3 shadow-2xl shadow-black/20 backdrop-blur" onSubmit={handleSubmit}>
            <label className="block">
              <span className="sr-only">输入探索消息</span>
              <textarea
                className="min-h-24 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-6 text-text outline-none placeholder:text-text-dim focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={sending}
                onChange={(event) => setContent(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="继续追问，或写下你的判断..."
                value={content}
              />
            </label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex items-center gap-2 text-xs text-text-dim">
                <span>回应角色</span>
                <select className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-text outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:opacity-60" disabled={sending} onChange={(event) => setRole(event.target.value as AIRole)} value={role}>
                  {AI_ROLE_OPTIONS.map((option) => <option key={option.role} value={option.role}>{option.label}</option>)}
                </select>
              </label>
              <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-ink transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50" disabled={!content.trim() || sending} type="submit">
                <Send aria-hidden="true" size={16} />
                {sending ? "发送中" : "发送"}
              </button>
            </div>
            {sendError ? <p className="text-xs text-danger" role="alert">{sendError}</p> : null}
          </form>
        </>
      )}
    </div>
  );
}
