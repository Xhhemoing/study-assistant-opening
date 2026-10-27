"use client";

import { useEffect, useMemo, useState } from "react";
import { TransitionLink as Link } from "../v3/motion/view-transition";
import { useRouter } from "next/navigation";
import { localDateKeyInZone } from "@aistudy/domain";
import type { TeachingActivity } from "@aistudy/contracts";
import { ConversationSurface } from "../assistant/conversation-companion";
import { createOpeningApi, type OpeningApi } from "../client/api";
import type { TodayResumeState } from "../planning/today-read";
import { TodayResumeBody } from "../planning/today-resume-view";
import { groupReviewTasks } from "../review/review-queue";
import { startSuggestions } from "./start-suggestions";
import { NextStepCard } from "./next-step-card";
import { useShellCounts } from "../shell/shell-counts-context";

const examples = ["为什么两个负数相乘是正数？", "帮我理解向量的张成", "我想安排考前复习"];

/**
 * 助理首页（/opening/today）：未开口先看到一张下一步、输入框和少量入口；开口后进入可回访的线程。
 * 下一步只来自已保存记录；待确认计数复用壳层已读结果，不重复请求。
 */
export function StartPage({ state, timeZone, api: apiProp }: { state: TodayResumeState; timeZone: string; api?: OpeningApi }) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const { pendingSuggestions } = useShellCounts();
  const router = useRouter();
  const [records, setRecords] = useState<{ activities: TeachingActivity[]; reviewCount: number | null; failed: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (state.kind === "loggedOut" || state.kind === "error") return;
    let active = true;
    const reviewCount = async () => {
      const response = await fetch("/api/reviews/count", { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" || !("count" in body) || !Number.isInteger(body.count) || (body.count as number) < 0) throw new Error("复习数量暂时无法读取。");
      return body.count as number;
    };
    void Promise.allSettled([api.listTeachingActivities(), api.listTasks(), reviewCount()]).then(([activities, tasks, due]) => {
      if (!active) return;
      setRecords({ activities: activities.status === "fulfilled" ? activities.value : [],
        reviewCount: tasks.status === "fulfilled" && due.status === "fulfilled" ? groupReviewTasks(tasks.value.tasks, Date.now()).ready.length + due.value : null,
        failed: [activities, tasks, due].some(result => result.status === "rejected"),
      });
    });
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [api, revision, state.kind]);
  if (state.kind === "loggedOut" || state.kind === "error") return <TodayResumeBody state={state} />;
  const suggestions = startSuggestions({ state, activities: records?.activities, reviewCount: records?.reviewCount, today: localDateKeyInZone(new Date(), timeZone) });
  const [lead, ...rest] = suggestions;
  return <div className="flex h-full min-h-0 min-w-0 flex-col">
    <nav aria-label="助理入口" className="flex justify-end gap-1 px-4 py-2">
      {pendingSuggestions ? <Link href="/opening/suggestions" className="inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3 text-meta text-text-2 hover:bg-text/5 hover:text-text focus-visible:ring-2 focus-visible:ring-accent">待确认<span className="tabular-nums text-accent">{pendingSuggestions}</span></Link> : null}
      <Link href="/opening/assistant" className="inline-flex min-h-11 items-center rounded-pill px-3 text-meta text-text-2 hover:bg-text/5 hover:text-text focus-visible:ring-2 focus-visible:ring-accent">全部讨论</Link>
    </nav>
    {records?.failed || state.courses?.status === "error" ? <p role="status" className="mx-auto w-full max-w-[720px] px-4 py-2 text-xs text-warn">部分学习记录暂时无法读取。<button type="button" className="min-h-8 px-2 underline" onClick={() => { setRevision(value => value + 1); router.refresh(); }}>重新读取</button></p> : null}
    <div className="min-h-0 flex-1"><ConversationSurface api={api} startFresh start={{
      greeting: lead ? "今天，接着往前一点。" : "从你想弄懂的事开始",
      subtitle: lead ? "我会接住你的进度，也可以随时换个方向。" : "提问、上传资料或直接写笔记，都可以。",
      lead: lead ? <NextStepCard item={lead} /> : undefined,
      suggestions: rest, examples }}
      onConversationReady={id => window.history.replaceState(window.history.state, "", `/opening/today?conversation=${encodeURIComponent(id)}`)} /></div>
  </div>;
}
