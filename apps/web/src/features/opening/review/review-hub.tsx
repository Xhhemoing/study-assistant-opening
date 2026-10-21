"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { CardReviewView } from "../cards/card-review-view";
import { createOpeningCardsClient } from "../cards/cards-client";
import { createOpeningApi } from "../client/api";
import { EmptyState, LoadError, LoadingRows, PageHeading, ui } from "../design/ui";
import { groupReviewTasks, loadReviewSources, type ReviewSources, type ReviewTask } from "./review-queue";
import { MixedReviewView } from "./mixed-review-view";
import { readReviewTab, reviewTabHref, reviewTabs, type ReviewTab } from "./review-route";

function ReviewTaskList({ items, upcoming = false }: { items: ReviewTask[]; upcoming?: boolean }) {
  return <ul className="divide-y divide-line rounded-xl border border-line">{items.map(({ task, kind, href, availableAt }) => <li key={task.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
    <div className="min-w-0 flex-1 space-y-1"><p className="text-xs text-text-2">{kind === "retest" ? "已安排复测" : "补强练习"} · 约 {task.minutes} 分钟</p><h3 className="break-words text-sm font-medium">{task.title}</h3>{task.skillLabel || task.retest?.skillLabel ? <p className="text-xs text-text-2">{task.retest?.skillLabel ?? task.skillLabel}</p> : null}{upcoming && availableAt ? <p className="text-xs text-text-2">最早开始：{new Date(availableAt).toLocaleString("zh-CN")}</p> : null}</div>
    {!href ? <span className="text-xs text-text-2">课程关联不可用，请到今天查看任务</span> : upcoming ? <span className="text-xs text-text-2">尚未到时间</span> : <Link className={ui.primary} href={href}>{kind === "retest" ? "开始复测" : "开始补强"}</Link>}
  </li>)}</ul>;
}

export function ReviewHub({ initialTab = "all" }: { initialTab?: ReviewTab }) {
  const api = useMemo(() => createOpeningApi(), []);
  const cardsClient = useMemo(() => createOpeningCardsClient(), []);
  const [tab, setTab] = useState(initialTab);
  const [search, setSearch] = useState("");
  const [cardsVisited, setCardsVisited] = useState(initialTab === "cards");
  const [remainingCards, setRemainingCards] = useState<number | null>(null);
  const [sources, setSources] = useState<ReviewSources | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const sync = () => {
      const next = readReviewTab(new URLSearchParams(window.location.search).get("tab") ?? undefined);
      setTab(next); setSearch(window.location.search);
      if (next === "cards") setCardsVisited(true);
    };
    sync(); window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => {
    let active = true;
    setSources(null);
    void loadReviewSources({ listCards: () => cardsClient.listDue("auto"), listTasks: () => api.listTasks() }).then(result => {
      if (active) { setSources(result); setLoadedAt(Date.now()); }
    });
    return () => { active = false; };
  }, [api, cardsClient, revision]);

  function navigate(event: MouseEvent<HTMLAnchorElement>, next: ReviewTab) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, "", reviewTabHref(next, window.location.search));
    setSearch(window.location.search); setTab(next);
    if (next === "cards") setCardsVisited(true);
  }
  const groups = sources?.tasks.kind === "ready" ? groupReviewTasks(sources.tasks.value, loadedAt) : null;
  const show = (item: ReviewTask) => tab === "all" || (tab === "retests" ? item.kind === "retest" : item.kind === "reinforcement");
  const ready = groups?.ready.filter(show) ?? [], upcoming = groups?.upcoming.filter(show) ?? [], unavailable = groups?.unavailable.filter(show) ?? [];
  const cardCount = cardsVisited ? remainingCards : sources?.cards.kind === "ready" ? sources.cards.value.length : null;

  return <section className="flex h-full min-h-0 flex-col bg-bg text-text">
    <PageHeading title="复习" description="到期卡片、已安排的复测和补强练习。" action={<Link className={ui.quiet} href="/opening/today">返回今天</Link>} />
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-5xl space-y-4 px-5 py-4">
      <nav aria-label="复习分类" className="flex gap-1 overflow-x-auto border-b border-line">{reviewTabs.map(item => <a key={item.id} className={`min-h-11 shrink-0 whitespace-nowrap border-b-2 px-2 py-3 text-sm focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${tab === item.id ? "border-ink font-medium text-accent" : "border-transparent text-text-2"}`} href={reviewTabHref(item.id, search)} onFocus={event => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })} onClick={event => navigate(event, item.id)} aria-current={tab === item.id ? "page" : undefined}>{item.label}</a>)}</nav>
      {tab === "all" ? <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line p-5" aria-labelledby="review-cards-heading"><div><h2 id="review-cards-heading" className="font-semibold">记忆卡片{cardCount !== null ? ` · ${cardCount} 张待复习` : ""}</h2><p className="mt-1 text-sm text-text-2">翻面后自评，自动安排下次复习。</p>{!cardsVisited && sources?.cards.kind === "error" ? <p role="alert" className="mt-2 text-sm text-danger">卡片读取失败：{sources.cards.message}</p> : null}</div><div className="flex flex-wrap gap-2"><a className={ui.primary} href={reviewTabHref("session", search)} onClick={event => navigate(event, "session")}>开始连续复习</a><a className={ui.secondary} href={reviewTabHref("cards", search)} onClick={event => navigate(event, "cards")}>复习卡片</a></div></section> : null}
      {tab === "session" ? <MixedReviewView cardsClient={cardsClient} taskClient={api} /> : null}
      <div hidden={tab !== "cards"}>{cardsVisited ? <CardReviewView embedded client={cardsClient} onRemainingChange={setRemainingCards} /> : null}</div>
      {tab !== "cards" && tab !== "session" ? <section className="space-y-4" aria-labelledby="review-tasks-heading">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="review-tasks-heading" className="font-semibold">{tab === "retests" ? "待复测" : tab === "reinforcement" ? "补强练习" : "复测与补强"}</h2><button type="button" className={ui.quiet} onClick={() => setRevision(value => value + 1)} disabled={!sources}>刷新队列</button></div>
        <p className="text-sm leading-6 text-text-2">这里显示你已安排的复测与补强练习。选择一项继续，尚未到时间的任务列在下方。</p>
        {!sources ? <LoadingRows label="正在读取复习任务…" /> : sources.tasks.kind === "error" ? <LoadError message={`复习任务读取失败：${sources.tasks.message}`} onRetry={() => setRevision(value => value + 1)} /> : <>
          {ready.length ? <ReviewTaskList items={ready} /> : <EmptyState title="当前没有可开始的任务" description={upcoming.length ? "下方任务尚未到开始时间，到时可刷新队列。" : "可以从课程中选择一道新题，或复习已有卡片。"} />}
          {upcoming.length ? <section className="space-y-3"><h3 className="text-sm font-semibold">接下来 · {upcoming.length}</h3><ReviewTaskList items={upcoming} upcoming /></section> : null}
          {unavailable.length ? <section className="space-y-3"><h3 className="text-sm font-semibold">暂不可开始</h3><ReviewTaskList items={unavailable} /><Link className={ui.quiet} href="/opening/today">到今天查看任务</Link></section> : null}
        </>}
      </section> : null}
      <p className="border-t border-line pt-3 text-xs text-text-2"><Link className="font-medium text-accent underline underline-offset-4" href="/opening/settings/planning#suggestions">查看学习建议</Link></p>
    </div></div>
  </section>;
}
