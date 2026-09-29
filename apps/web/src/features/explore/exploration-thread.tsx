"use client";

import { ui } from "../opening/design/ui";
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
        <span className={`mt-1 inline-grid size-8 shrink-0 place-items-center rounded-full ${user ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
          {user ? <UserRound aria-hidden="true" size={16} /> : <Bot aria-hidden="true" size={16} />}
        </span>
        <div className={`min-w-0 space-y-1 ${user ? "text-right" : ""}`}>
          <div className={`flex items-center gap-2 text-xs text-zinc-500 ${user ? "justify-end" : ""}`}>
            <span>{user ? "你" : `AI · ${getRoleLabel(turn.aiRole ?? "explainer")}`}</span>
            <time dateTime={turn.createdAt}>{formatCreatedAt(turn.createdAt)}</time>
          </div>
          <p className={`whitespace-pre-wrap break-words rounded-md px-3 py-2 text-sm leading-7 ${user ? "bg-zinc-100 text-zinc-800" : "bg-white text-zinc-800"}`}>
            {turn.content}
          </p>
          {turn.simulated ? <span className="text-[11px] text-zinc-500">模拟回复</span> : null}
        </div>
      </div>
    </article>
  );
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8" aria-busy="true">
      <div className="h-5 w-28  rounded bg-zinc-100" />
      <div className="space-y-3 border-b border-zinc-200 pb-4">
        <div className="h-8 w-2/3  rounded bg-zinc-100" />
        <div className="h-4 w-1/3  rounded bg-zinc-100" />
      </div>
      <div className="space-y-6">
        <div className="ml-auto h-20 w-2/3  rounded-lg bg-zinc-100" />
        <div className="h-24 w-3/4  rounded-lg bg-zinc-100" />
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
    if (!shouldSendOnEnter(event.key, event.shiftKey, event.nativeEvent.isComposing)) return;
    event.preventDefault();
    void sendMessage();
  }

  function handleCandidateChange(candidate: PromotionCandidate) {
    setCandidates((current) => current.map((item) => item.id === candidate.id ? candidate : item));
  }

  if (loading || !provider) return <ThreadSkeleton />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
      <Link className="inline-flex w-fit items-center gap-2 text-sm text-zinc-500 transition-colors duration-150 motion-reduce:transition-none hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" href="/explore">
        <ArrowLeft aria-hidden="true" size={16} />
        返回探索
      </Link>

      <header className="space-y-3 border-b border-zinc-200 pb-4">
        <p className="text-xs text-zinc-500">自由探索 · 对话线程</p>
        <h1 className="break-words text-xl font-semibold tracking-[-0.02em] text-zinc-900">{title || "探索"}</h1>
        <p className="text-sm text-zinc-500">保留原始问题，再决定哪些内容值得沉淀。</p>
      </header>

      {loadError ? (
        <section className="space-y-3 border-y border-zinc-200 py-8" role="alert">
          <p className="text-sm text-red-700">{loadError}</p>
          <button className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-900 transition-colors duration-150 motion-reduce:transition-none hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600" type="button" onClick={() => setRetryToken((value) => value + 1)}>重试</button>
        </section>
      ) : (
        <>
          <section className="space-y-6" aria-label="探索对话" aria-live="polite">
            {turns.map((turn) => <ThreadTurn key={turn.id} turn={turn} />)}
            {typing ? <p className="text-xs text-zinc-500" role="status">AI 正在整理回复...</p> : null}
            {turns.length === 0 && !typing ? <p className="border-y border-zinc-200 py-10 text-center text-sm text-zinc-500">从你的第一个问题开始。</p> : null}
          </section>

          <CandidatePanel
            candidates={candidates}
            explorationTitle={title}
            onCandidateChange={handleCandidateChange}
          />

          <form className="sticky bottom-0 space-y-3 border-t border-zinc-200 bg-white py-3" onSubmit={handleSubmit}>
            <label className="block">
              <span className="sr-only">输入探索消息</span>
              <textarea
                className="min-h-24 w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm leading-7 text-zinc-900 outline-none placeholder:text-zinc-500 focus:border-emerald-600 focus:ring-2 focus:ring-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={sending}
                onChange={(event) => setContent(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="继续追问，或写下你的判断..."
                value={content}
              />
            </label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <label className="flex items-center gap-2 text-xs text-zinc-500">
                <span>回应角色</span>
                <select className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-zinc-200 disabled:opacity-60" disabled={sending} onChange={(event) => setRole(event.target.value as AIRole)} value={role}>
                  {AI_ROLE_OPTIONS.map((option) => <option key={option.role} value={option.role}>{option.label}</option>)}
                </select>
              </label>
              <button className={ui.primary} disabled={!content.trim() || sending} type="submit">
                <Send aria-hidden="true" size={16} />
                {sending ? "发送中" : "发送"}
              </button>
            </div>
            {sendError ? <p className="text-xs text-red-700" role="alert">{sendError}</p> : null}
          </form>
        </>
      )}
    </div>
  );
}
