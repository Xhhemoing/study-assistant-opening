"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
import { CardReviewView } from "../cards/card-review-view";
import { createOpeningCardsClient, type OpeningCardsClient } from "../cards/cards-client";
import { createOpeningApi } from "../client/api";
import { EmptyState, LoadError, LoadingRows, ui } from "../design/ui";
import { loadReviewSources, type ReviewSources } from "./review-queue";
import { createMixedReviewSession, readMixedReviewSession, resolveMixedReviewSession, reviewEntryKey, saveMixedReviewSession, type MixedReviewSession } from "./mixed-review-session";
import type { TaskItem } from "@aistudy/contracts";

type TaskClient = { listTasks: () => Promise<{ tasks: TaskItem[] }> };
export function MixedReviewView({ cardsClient: suppliedCards, taskClient: suppliedTasks }: { cardsClient?: OpeningCardsClient; taskClient?: TaskClient }) {
  const cardsClient = useMemo(() => suppliedCards ?? createOpeningCardsClient(), [suppliedCards]);
  const taskClient = useMemo(() => suppliedTasks ?? createOpeningApi(), [suppliedTasks]);
  const [namespace] = useState(getVerifiedSessionNamespace);
  const [session, setSession] = useState<MixedReviewSession | null>(null);
  const [sources, setSources] = useState<ReviewSources | null>(null);
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState("");
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const request = useRef(0);
  const loadedAt = useRef(0);
  const onBusyChange = useCallback((next: boolean) => { busyRef.current = next; setBusy(next); }, []);
  const stillOwned = useCallback(() => getVerifiedSessionNamespace() === namespace, [namespace]);
  const refresh = useCallback(async () => {
    if (busyRef.current || !stillOwned()) return;
    const currentRequest = ++request.current;
    setLoading(true);
    const next = await loadReviewSources({ listCards: () => cardsClient.listDue("auto"), listTasks: () => taskClient.listTasks() });
    if (currentRequest !== request.current || !stillOwned()) return;
    loadedAt.current = Date.now();
    setSources(next); setLoading(false);
  }, [cardsClient, taskClient, stillOwned]);

  useEffect(() => {
    if (namespace) {
      try { setSession(readMixedReviewSession(window.localStorage, namespace)); }
      catch { setStorageBlocked(true); setStorageError("本轮进度暂时无法读取。重新开始只重排复习顺序，不会删除已有评分或作答。"); }
    }
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onVisible);
    return () => { request.current++; window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [namespace, refresh]);

  const persist = useCallback((next: MixedReviewSession) => {
    if (!stillOwned()) return;
    setSession(next);
    if (namespace) {
      try { saveMixedReviewSession(window.localStorage, namespace, next); setStorageError(""); }
      catch { setStorageError("本轮顺序暂时只能保留在当前页面。已保存的评分和作答仍在服务端，请恢复浏览器存储后再离开。"); }
    }
  }, [namespace, stillOwned]);
  useEffect(() => {
    if (!session && !storageBlocked && sources?.cards.kind === "ready" && sources.tasks.kind === "ready") {
      persist(createMixedReviewSession(sources.cards.value, sources.tasks.value, loadedAt.current));
    }
  }, [sources, session, storageBlocked, persist]);

  const resolved = session && sources?.cards.kind === "ready" && sources.tasks.kind === "ready"
    ? resolveMixedReviewSession(session, sources.cards.value, sources.tasks.value, loadedAt.current) : [];
  const current = resolved.find(entry => entry.status === "card" || entry.status === "task");
  const currentCardId = current?.status === "card" ? current.item.card.id : null;
  // Re-read the actual due queue when the card asks to reload; never submit a stale snapshot.
  const singleCardClient = useMemo<OpeningCardsClient>(() => ({ ...cardsClient,
    listDue: async mode => (await cardsClient.listDue(mode)).filter(item => item.card.id === currentCardId),
  }), [cardsClient, currentCardId]);
  const onGraded = useCallback((cardId: string) => {
    if (!stillOwned() || cardId !== currentCardId) return;
    setSources(previous => previous?.cards.kind === "ready" ? { ...previous, cards: { kind: "ready", value: previous.cards.value.filter(item => item.card.id !== cardId) } } : previous);
  }, [currentCardId, stillOwned]);
  const onCardRemaining = useCallback((remaining: number | null) => {
    // A card can have left the due queue in another tab. This is not a completion claim.
    if (remaining === 0 && currentCardId) onGraded(currentCardId);
  }, [currentCardId, onGraded]);
  function restart() {
    if (busyRef.current || sources?.cards.kind !== "ready" || sources.tasks.kind !== "ready") return;
    setStorageBlocked(false);
    persist(createMixedReviewSession(sources.cards.value, sources.tasks.value, loadedAt.current));
  }
  function skip() {
    if (!session || !current || busyRef.current) return;
    persist({ ...session, skipped: [...session.skipped, reviewEntryKey(current.entry)] });
  }
  const pending = resolved.filter(entry => entry.status === "card" || entry.status === "task").length;
  const skipped = resolved.filter(entry => entry.status === "skipped").length;
  const waiting = resolved.filter(entry => entry.status === "waiting" || entry.status === "unavailable").length;
  const doneTasks = resolved.filter(entry => entry.status === "done").length;
  const removedCards = resolved.filter(entry => entry.status === "no_longer_due").length;

  return <section aria-labelledby="mixed-review-heading" className="min-w-0 space-y-5">
    <header className="space-y-3"><h2 id="mixed-review-heading" className="text-lg font-semibold">连续复习</h2>
      <p className="text-sm leading-7 text-text-2">到期卡片和已安排的练习交替进行。卡片保留自评含义；任务完成状态以服务端记录为准。</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={ui.quiet} disabled={loading || busy} onClick={() => void refresh()}>核对最新进度</button><button type="button" className={ui.quiet} disabled={loading || busy || sources?.cards.kind !== "ready" || sources.tasks.kind !== "ready"} onClick={restart}>重新安排本轮</button></div>
    </header>
    {storageError ? <p role="alert" className="text-sm text-warn">{storageError}</p> : null}
    {loading ? <LoadingRows label="正在核对当前复习项目…" /> : sources?.cards.kind === "error" || sources?.tasks.kind === "error" ? <LoadError message={`无法核对完整队列：${[sources.cards.kind === "error" ? sources.cards.message : "", sources.tasks.kind === "error" ? sources.tasks.message : ""].filter(Boolean).join("；")}`} onRetry={() => void refresh()} /> : !storageBlocked && session ? <>
      <p role="status" className="text-xs leading-6 text-text-2">本轮 {session.entries.length} 项 · 当前可继续 {pending} 项 · 本轮略过 {skipped} 项{waiting ? ` · 暂不可开始 ${waiting} 项` : ""}</p>
      {doneTasks || removedCards ? <p className="text-xs leading-6 text-text-3">服务端已完成任务 {doneTasks} 项；卡片已不在本轮到期队列 {removedCards} 张。队列进度不表示独立掌握。</p> : null}
      {current?.status === "card" ? <CardReviewView key={current.item.card.id} embedded compact client={singleCardClient} onGraded={onGraded} onBusyChange={onBusyChange} onRemainingChange={onCardRemaining} returnTo="/opening/review?tab=session" /> : current?.status === "task" ? <article className="space-y-4 rounded-xl border border-line bg-surface p-5">
        <p className="text-xs text-text-2">{current.item.kind === "retest" ? "已安排复测" : "补强练习"} · 约 {current.item.task.minutes} 分钟</p>
        <h3 className="break-words text-base font-medium">{current.item.task.title}</h3>
        <p className="text-sm leading-7 text-text-2">在新标签中完成练习后回到这里。返回时会自动核对；打开练习不会把任务标为完成。</p>
        <a className={ui.primary} href={current.item.href!} target="_blank" rel="noopener noreferrer">打开练习（新标签）</a>
      </article> : <EmptyState title={session.entries.length ? "本轮当前没有可继续的项目" : "当前没有可开始的复习项目"} description={waiting ? "仍有尚未到期或暂不可用的项目。到时核对最新进度即可继续。" : skipped ? "本轮略过的项目没有被标为完成。重新安排本轮可再次加入。" : "可稍后重新安排本轮，纳入新的到期卡片和已接受任务。"} />}
      {current ? <button type="button" className={ui.quiet} disabled={busy} onClick={skip}>本轮先略过这一项</button> : null}
    </> : null}
  </section>;
}
