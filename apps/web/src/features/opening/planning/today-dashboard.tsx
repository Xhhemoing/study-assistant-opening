"use client";
import Link from "next/link";
import { ChevronDown, ListTodo } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TaskQueueRefreshContext } from "./task-status-control";
import { buttonClass, secondaryButtonClass, ui } from "../design/ui";
import type { OpeningApi } from "../client/api";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { createOpeningCardsClient } from "../cards/cards-client";
import type { TodayResumeState } from "./today-read";
import { TodayResumeBody } from "./today-resume-view";
import { localDateKey, resolveTodayTimeZone, TodayPlanView } from "./today-view";
import type { StudyTask } from "./study-task";
import { TodayLearningContext } from "./today-overview";
import type { TeachingActivity } from "@aistudy/contracts";
import { TeachingActivityEmpty, TeachingActivityPanel } from "../teaching/activity-panel";
import {
  buildStartLearningCreateInput,
  pickCurrentTeachingActivity,
  todayActivityCtaLabel,
} from "../teaching/today-activity";

export function shouldOpenTodayQueue(focusTaskId?: string): boolean {
  return Boolean(focusTaskId);
}

export function shouldCloseTodayQueue(source?: "focus" | "user"): boolean {
  return source !== "focus";
}

export function TodayDashboard({ state, api: apiProp, focusTaskId }: { state: TodayResumeState; api?: OpeningApi; focusTaskId?: string }) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  const [task, setTask] = useState<StudyTask | null>(null);
  const [queueOpen, setQueueOpen] = useState(() => shouldOpenTodayQueue(focusTaskId));
  const [reloadToken, setReloadToken] = useState(0);
  const [dueCardCount, setDueCardCount] = useState(0);
  const [activities, setActivities] = useState<TeachingActivity[]>([]);
  const [activityLoad, setActivityLoad] = useState<"loading" | "ready" | "error">("loading");
  const [selectedActivity, setSelectedActivity] = useState<TeachingActivity | null>(null);
  const [ctaBusy, setCtaBusy] = useState(false);
  const [ctaError, setCtaError] = useState<string | null>(null);
  const timeZone = useMemo(() => resolveTodayTimeZone(), []);
  const cards = useMemo(() => createOpeningCardsClient(), []);
  const rereadQueue = useCallback(() => { setReloadToken((value) => value + 1); }, []);
  const currentActivity = selectedActivity ?? pickCurrentTeachingActivity(activities);
  const ctaLabel = todayActivityCtaLabel(pickCurrentTeachingActivity(activities));
  const assistantHref = state.continueItem
    ? `/opening/assistant?conversation=${encodeURIComponent(state.continueItem.conversationId)}`
    : "/opening/assistant";

  useEffect(() => {
    if (focusTaskId) setQueueOpen(true);
  }, [focusTaskId]);

  useEffect(() => {
    if (state.kind !== "ready" && state.kind !== "empty") {
      setDueCardCount(0);
      return;
    }
    const controller = new AbortController();
    cards.listDue("auto")
      .then((items) => {
        if (!controller.signal.aborted) setDueCardCount(items.length);
      })
      .catch(() => {
        if (!controller.signal.aborted) setDueCardCount(0);
      });
    return () => controller.abort();
  }, [cards, reloadToken, state.kind]);

  useEffect(() => {
    if (state.kind !== "ready" && state.kind !== "empty") return;
    const controller = new AbortController();
    setActivityLoad("loading");
    api.listTeachingActivities()
      .then((rows) => {
        if (controller.signal.aborted) return;
        setActivities(rows);
        setActivityLoad("ready");
        setSelectedActivity((prev) => prev ?? pickCurrentTeachingActivity(rows));
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setActivities([]);
        setActivityLoad("error");
      });
    return () => controller.abort();
  }, [api, reloadToken, state.kind]);

  const select = useCallback((next: StudyTask, source?: "focus" | "user") => {
    setTask(next);
    if (shouldCloseTodayQueue(source)) setQueueOpen(false);
  }, []);

  const runPrimaryCta = useCallback(async () => {
    setCtaError(null);
    const existing = pickCurrentTeachingActivity(activities);
    if (existing) {
      setSelectedActivity(existing);
      return;
    }
    setCtaBusy(true);
    try {
      const input = buildStartLearningCreateInput({
        localDate: localDateKey(new Date()),
        continueTitle: state.continueItem?.title,
        continueConversationId: state.continueItem?.conversationId,
      });
      const created = await api.createTeachingActivity(input);
      setActivities((rows) => {
        const without = rows.filter((row) => row.id !== created.id);
        return [created, ...without];
      });
      setSelectedActivity(created);
      setActivityLoad("ready");
    } catch (error) {
      const message =
        error instanceof OpeningApiError ? error.message : "创建教学活动失败";
      setCtaError(message);
    } finally {
      setCtaBusy(false);
    }
  }, [activities, api, state.continueItem]);

  if (state.kind === "loggedOut" || state.kind === "error") {
    return <TodayResumeBody state={state} />;
  }

  return (
    <TaskQueueRefreshContext.Provider value={rereadQueue}>
      <div className="flex h-full min-h-0 flex-col">
        <h1 className="sr-only">今日学习工作台</h1>
        <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 lg:hidden">
          <span className="text-xs font-medium text-zinc-800">今日学习</span>
          <button
            className={secondaryButtonClass}
            type="button"
            aria-expanded={queueOpen}
            aria-controls="today-queue"
            onClick={() => setQueueOpen(!queueOpen)}
          >
            <ListTodo size={14} aria-hidden />
            任务队列
            <ChevronDown size={12} aria-hidden />
          </button>
        </header>
        <div className="shrink-0 group-data-[focus=true]/workspace:hidden">
          <TodayLearningContext
            item={state.continueItem}
            primaryAction={
              <button
                type="button"
                className={buttonClass}
                data-today-primary-cta="true"
                onClick={() => void runPrimaryCta()}
                disabled={ctaBusy || activityLoad === "loading"}
              >
                {ctaBusy ? "处理中…" : ctaLabel}
              </button>
            }
            secondaryAction={
              <Link href={assistantHref} className={ui.quiet}>
                自由对话
              </Link>
            }
          />
          {ctaError ? (
            <p className="px-4 text-xs text-red-700 sm:px-5" role="alert">{ctaError}</p>
          ) : null}
          {activityLoad === "error" ? (
            <p className="px-4 text-xs text-amber-800 sm:px-5" role="status">
              教学活动暂时无法读取；仍可使用自由对话。
            </p>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-1 group-data-[focus=true]/workspace:lg:grid-cols-1">
          <div
            id="today-queue"
            className={`${queueOpen ? "flex" : "hidden"} max-h-72 min-h-0 shrink-0 flex-col overflow-y-auto border-b border-zinc-200 bg-zinc-50 lg:flex lg:max-h-none lg:border-b-0 lg:border-r group-data-[focus=true]/workspace:hidden`}
          >
            {(state.pendingReviews?.count ?? 0) > 0 ? (
              <Link
                href="/opening/review"
                className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[11px] leading-5 text-amber-900 focus-visible:ring-2 focus-visible:ring-emerald-700"
              >
                {state.pendingReviews!.count} 项建议待审核 · 不影响继续学习
              </Link>
            ) : null}
            {dueCardCount > 0 ? (
              <Link
                href="/opening/cards"
                className="shrink-0 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-[11px] leading-5 text-emerald-900 focus-visible:ring-2 focus-visible:ring-emerald-700"
              >
                {dueCardCount} 张记忆卡片到期
              </Link>
            ) : null}
            <TodayPlanView
              api={api}
              focusTaskId={focusTaskId}
              selectedId={task?.id}
              onSelect={select}
              reloadToken={reloadToken}
              timeZone={timeZone}
            />
          </div>
          <div className="min-h-0 min-w-0 flex-1 bg-white">
            {currentActivity ? (
              <TeachingActivityPanel
                activity={currentActivity}
                assistantHref={assistantHref}
                timeZone={timeZone}
              />
            ) : (
              <TeachingActivityEmpty
                onStart={() => void runPrimaryCta()}
                busy={ctaBusy}
                error={ctaError}
                assistantHref={assistantHref}
              />
            )}
          </div>
        </div>
      </div>
    </TaskQueueRefreshContext.Provider>
  );
}
