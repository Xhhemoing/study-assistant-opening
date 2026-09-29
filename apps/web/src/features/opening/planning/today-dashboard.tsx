"use client";
import Link from "next/link";
import { ChevronDown, ListTodo } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { secondaryButtonClass } from "../design/ui";
import { AssistantView } from "../assistant/assistant-view";
import type { OpeningApi } from "../client/api";
import type { TodayResumeState } from "./today-read";
import { TodayResumeBody } from "./today-resume-view";
import { TodayPlanView } from "./today-view";
import type { StudyTask } from "./study-task";
export function shouldOpenTodayQueue(focusTaskId?: string): boolean {
  return Boolean(focusTaskId);
}

export function shouldCloseTodayQueue(source?: "focus" | "user"): boolean {
  return source !== "focus";
}

export function TodayDashboard({ state, api, focusTaskId }: { state: TodayResumeState; api?: OpeningApi; focusTaskId?: string }) {
  const [task, setTask] = useState<StudyTask | null>(null), [queueOpen, setQueueOpen] = useState(() => shouldOpenTodayQueue(focusTaskId));
  useEffect(() => {
    if (focusTaskId) setQueueOpen(true);
  }, [focusTaskId]);
  const select = useCallback((next: StudyTask, source?: "focus" | "user") => { setTask(next); if (shouldCloseTodayQueue(source)) setQueueOpen(false); }, []);
  if (state.kind === "loggedOut" || state.kind === "error") return <TodayResumeBody state={state} />;
  return <div className="flex h-full min-h-0 flex-col">
    <h1 className="sr-only">今日学习工作台</h1>
    <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 lg:hidden"><span className="text-xs font-medium text-zinc-800">今日学习</span><button className={secondaryButtonClass} type="button" aria-expanded={queueOpen} aria-controls="today-queue" onClick={() => setQueueOpen(!queueOpen)}><ListTodo size={14} aria-hidden />任务队列<ChevronDown size={12} aria-hidden /></button></header>
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-1 group-data-[focus=true]/workspace:lg:grid-cols-1">
      <div id="today-queue" className={`${queueOpen ? "flex" : "hidden"} max-h-72 min-h-0 shrink-0 flex-col overflow-y-auto border-b border-zinc-200 bg-zinc-50 lg:flex lg:max-h-none lg:border-b-0 lg:border-r group-data-[focus=true]/workspace:hidden`}>
        {(state.pendingReviews?.count ?? 0) > 0 ? <Link href="/opening/review" className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] leading-5 text-amber-900 focus-visible:ring-2 focus-visible:ring-emerald-700">{state.pendingReviews!.count} 项建议待审核 · 不影响继续学习</Link> : null}
        <TodayPlanView api={api} focusTaskId={focusTaskId} selectedId={task?.id} onSelect={select} />
      </div>
      <div className="min-h-0 min-w-0 flex-1"><AssistantView api={api} initialConversationId={state.continueItem?.conversationId ?? null} initialTitle={state.continueItem?.title} startFresh={!state.continueItem} task={task} embedded /></div>
    </div>
  </div>;
}
