"use client";
import Link from "next/link";
import { ChevronDown, ListTodo } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TaskQueueRefreshContext } from "./task-status-control";
import { buttonClass, secondaryButtonClass, ui } from "../design/ui";
import type { OpeningApi } from "../client/api";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { createOpeningCardsClient } from "../cards/cards-client";
import type { TodayResumeState } from "./today-read";
import { TodayResumeBody } from "./today-resume-view";
import { localDateKey, resolveTodayTimeZone, TodayPlanView } from "./today-view";
import type { StudyTask } from "./study-task";
import { CourseStudyContextTools } from "../../courses/course-study-context-tools";
import { TodayLearningContext } from "./today-overview";
import { focusPriorityActions } from "./today-task-selection";
import type { ActivitySpecClientInit, LearningResume, TeachingActivity } from "@aistudy/contracts";
import { TeachingActivityEmpty } from "../teaching/activity-panel";
import {
  buildStartLearningCreateInput,
  pickCurrentTeachingActivity,
  todayActivityCtaLabel,
} from "../teaching/today-activity";
import {
  isTeachingWorkspaceContentUsable,
  TeachingContinueEntry,
} from "../teaching/teaching-workspace";
import { useOpeningCapabilities } from "../capabilities/capabilities-provider";
import { TeachingLoopTrialEmpty } from "../teaching/teaching-loop-trial-empty";
import { TaskLearningActionContext } from "./task-row-actions";


/** Visible outcome when the Today primary CTA runs with/without an existing activity. */
export type TodayPrimaryCtaPlan =
  | { kind: "create" }
  | {
      kind: "focus-existing";
      activityId: string;
      /** Open workspace immediately when clientInit is already usable. */
      preferWorkspace: boolean;
    };

export function planTodayPrimaryCta(
  existing: TeachingActivity | null,
  clientInit: ActivitySpecClientInit | null | undefined,
): TodayPrimaryCtaPlan {
  if (!existing) return { kind: "create" };
  const preferWorkspace = Boolean(
    clientInit && isTeachingWorkspaceContentUsable(existing, clientInit),
  );
  return { kind: "focus-existing", activityId: existing.id, preferWorkspace };
}

export function shouldOpenTodayQueue(focusTaskId?: string): boolean {
  return Boolean(focusTaskId);
}

export function shouldCloseTodayQueue(source?: "focus" | "user"): boolean {
  return source !== "focus";
}

export function TodayDashboard({
  state,
  api: apiProp,
  focusTaskId,
  teachingWorkspaceEnabled: teachingWorkspaceEnabledProp,
  teachingLoopEnabled: teachingLoopEnabledProp,
  teachingLoopTrialEnabled: teachingLoopTrialEnabledProp,
  teachingCompileEnabled = true,
  timeZone: workspaceTimeZone,
}: {
  state: TodayResumeState;
  /** Workspace business IANA zone resolved on the server (planning_settings.timeZone). */
  timeZone?: string;
  api?: OpeningApi;
  focusTaskId?: string;
  /** Override for tests; default = server capabilities teachingLoop.ui. */
  teachingWorkspaceEnabled?: boolean;
  /** Override for tests; default = server capabilities teachingLoop.api. */
  teachingLoopEnabled?: boolean;
  /**
   * Override dual trial gate for tests.
   * Default = loop && workspace (V2-16 UI trial; both flags required).
   */
  teachingLoopTrialEnabled?: boolean;
  /** Server-resolved OPENING_TEACHING_COMPILER_ENABLED — hide compile CTA when false. */
  teachingCompileEnabled?: boolean;
}) {
  const api = useMemo(() => apiProp ?? createOpeningApi(), [apiProp]);
  // PR-H: UI visibility comes from GET /api/opening/capabilities (server switches),
  // never from process.env in this client component. The API re-checks anyway.
  const capabilities = useOpeningCapabilities();
  const teachingWorkspaceEnabled =
    teachingWorkspaceEnabledProp ?? capabilities.teachingLoop.ui;
  const teachingLoopEnabled =
    teachingLoopEnabledProp ?? capabilities.teachingLoop.api;
  const teachingLoopTrialEnabled =
    teachingLoopTrialEnabledProp ??
    (teachingLoopEnabledProp !== undefined ||
    teachingWorkspaceEnabledProp !== undefined
      ? teachingLoopEnabled && teachingWorkspaceEnabled
      : capabilities.teachingLoop.api && capabilities.teachingLoop.ui);
  const [task, setTask] = useState<StudyTask | null>(null);
  const [queueOpen, setQueueOpen] = useState(() => shouldOpenTodayQueue(focusTaskId));
  const [queueEmpty, setQueueEmpty] = useState(false);
  const desktopQueue = !queueEmpty || queueOpen || (state.pendingReviews?.count ?? 0) > 0;
  const [actionsRequested, setActionsRequested] = useState(false);
  const showActions = useCallback(() => { setQueueOpen(true); setActionsRequested(true); }, []);
  const [reloadToken, setReloadToken] = useState(0);
  const [dueCardsError, setDueCardsError] = useState(false);
  const [dueCardCount, setDueCardCount] = useState(0);
  const showDesktopQueue = desktopQueue || dueCardCount > 0 || dueCardsError;
  const [activities, setActivities] = useState<TeachingActivity[]>([]);
  const [activityLoad, setActivityLoad] = useState<"loading" | "ready" | "error">("loading");
  const [selectedActivity, setSelectedActivity] = useState<TeachingActivity | null>(null);
  const [ctaBusy, setCtaBusy] = useState(false);
  const [ctaError, setCtaError] = useState<string | null>(null);
  /** Bumped on 「继续学习」 so an already-selected activity still produces a visible focus. */
  const [ctaFocusNonce, setCtaFocusNonce] = useState(0);
  const [ctaPreferWorkspace, setCtaPreferWorkspace] = useState(false);
  const teachingPaneRef = useRef<HTMLDivElement | null>(null);
  const [clientInit, setClientInit] = useState<ActivitySpecClientInit | null>(null);
  const [clientInitLoad, setClientInitLoad] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [learningResume, setLearningResume] = useState<LearningResume | null>(null);
  const [resumeLoad, setResumeLoad] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const timeZone = useMemo(() => resolveTodayTimeZone(workspaceTimeZone), [workspaceTimeZone]);
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
    setDueCardsError(false);
    cards.listDue("auto")
      .then((items) => {
        if (!controller.signal.aborted) setDueCardCount(items.length);
      })
      .catch(() => {
        if (!controller.signal.aborted) { setDueCardCount(0); setDueCardsError(true); }
      });
    return () => controller.abort();
  }, [cards, reloadToken, state.kind]);
  useEffect(() => {
    if (actionsRequested && queueOpen && focusPriorityActions(document.getElementById("action-digest"))) {
      setActionsRequested(false);
    }
  }, [actionsRequested, queueOpen, state.kind]);

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

  // V2-14: prefer LearningResume package for continue; clientInit may be null (fail-soft).
  useEffect(() => {
    if (!teachingLoopTrialEnabled || !currentActivity) {
      setClientInit(null);
      setClientInitLoad("idle");
      setLearningResume(null);
      setResumeLoad("idle");
      return;
    }
    const controller = new AbortController();
    setResumeLoad("loading");
    api
      .getTeachingResume(currentActivity.id)
      .then((resume) => {
        if (controller.signal.aborted) return;
        setLearningResume(resume);
        setResumeLoad("ready");
        if (resume.clientInit) {
          setClientInit(resume.clientInit);
          setClientInitLoad("ready");
        } else if (currentActivity.generateStatus === "ready") {
          // Prefer resume.clientInit; fall back to dedicated client-init when resume null.
          setClientInitLoad("loading");
          return api
            .getTeachingClientInit(currentActivity.id)
            .then((init) => {
              if (controller.signal.aborted) return;
              setClientInit(init);
              setClientInitLoad("ready");
            })
            .catch(() => {
              if (controller.signal.aborted) return;
              setClientInit(null);
              setClientInitLoad("error");
            });
        } else {
          setClientInit(null);
          setClientInitLoad("idle");
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLearningResume(null);
        setResumeLoad("error");
        // Fail-soft: keep prior V2-10 path via client-init when generate ready.
        if (currentActivity.generateStatus === "ready") {
          setClientInitLoad("loading");
          return api
            .getTeachingClientInit(currentActivity.id)
            .then((init) => {
              if (controller.signal.aborted) return;
              setClientInit(init);
              setClientInitLoad("ready");
            })
            .catch(() => {
              if (controller.signal.aborted) return;
              setClientInit(null);
              setClientInitLoad("error");
            });
        } else {
          setClientInit(null);
          setClientInitLoad("idle");
        }
      });
    return () => controller.abort();
  }, [api, currentActivity, teachingLoopTrialEnabled, reloadToken]);

  const clearSelection = useCallback(() => setTask(null), []);
  const select = useCallback((next: StudyTask, source?: "focus" | "user") => {
    setTask(next);
    if (shouldCloseTodayQueue(source)) setQueueOpen(false);
  }, []);
  const taskStartInFlight = useRef(false);

  const runPrimaryCta = useCallback(async () => {
    if (taskStartInFlight.current) return;
    setCtaError(null);
    const existing = pickCurrentTeachingActivity(activities);
    const plan = planTodayPrimaryCta(existing, clientInit);
    if (plan.kind === "focus-existing") {
      setSelectedActivity(existing);
      setCtaPreferWorkspace(plan.preferWorkspace);
      setCtaFocusNonce((n) => n + 1);
      return;
    }
    taskStartInFlight.current = true;
    setCtaBusy(true);
    try {
      const continueSources = Object.keys(state.continueItem?.sourceVersions ?? {});
      const input = buildStartLearningCreateInput({
        localDate: localDateKey(new Date(), timeZone),
        continueTitle: state.continueItem?.title,
        continueConversationId: state.continueItem?.conversationId,
        continueSourceIds: continueSources,
        courseId: state.continueItem?.courseId,
        // Conversation title is the best available label when starting from continue context.
        courseTitle: state.continueItem?.title,
        sourceIds: continueSources,
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
      taskStartInFlight.current = false;
      setCtaBusy(false);
    }
  }, [activities, api, clientInit, state.continueItem, timeZone]);

  const startTaskLearning = useCallback(async (selected: StudyTask) => {
    if (taskStartInFlight.current || !teachingLoopTrialEnabled) return;
    taskStartInFlight.current = true; setCtaBusy(true); setCtaError(null);
    try {
      const created = await api.createTeachingActivity(buildStartLearningCreateInput({
        localDate: localDateKey(new Date(), timeZone), taskId: selected.id,
        courseId: selected.courseId, courseTitle: selected.title,
      }));
      setTask(selected);
      setActivities((rows) => [created, ...rows.filter((row) => row.id !== created.id)]);
      setSelectedActivity(created); setActivityLoad("ready");
      setCtaPreferWorkspace(true); setCtaFocusNonce((n) => n + 1); setQueueOpen(false);
    } catch (reason) { setCtaError(reason instanceof Error ? reason.message : "任务主讲创建未确认，请用同一任务重新读取。"); }
    finally { taskStartInFlight.current = false; setCtaBusy(false); }
  }, [api, teachingLoopTrialEnabled, timeZone]);


  useEffect(() => {
    if (ctaFocusNonce === 0) return;
    teachingPaneRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [ctaFocusNonce]);

  if (state.kind === "loggedOut" || state.kind === "error") {
    return <TodayResumeBody state={state} />;
  }

  return (
    <TaskQueueRefreshContext.Provider value={rereadQueue}>
      <TaskLearningActionContext.Provider value={teachingLoopTrialEnabled ? { start: (selected) => { void startTaskLearning(selected); }, busy: ctaBusy } : null}>
      <div className="flex h-full min-h-0 flex-col">
        <h1 className="sr-only">今日学习工作台</h1>
        {dueCardsError ? <p role="status" className="shrink-0 px-5 py-2 text-xs text-amber-800">到期卡片暂时无法读取。<button type="button" className={ui.quiet} onClick={rereadQueue}>重新读取</button></p> : null}
        <header className={`flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 ${showDesktopQueue && !queueEmpty ? "lg:hidden" : ""} group-data-[focus=true]/workspace:hidden`}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800" title={task?.title}>{task?.title ?? (queueEmpty ? "今天还未安排任务" : "今日学习 · 可直接开始自由学习")}</span>
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
            activity={currentActivity ? { title: currentActivity.intentSummary, courseId: currentActivity.courseId } : null}
            onShowActions={showActions}
            primaryAction={currentActivity?.courseId ? <Link className={buttonClass} href={`/opening/courses/${encodeURIComponent(currentActivity.courseId)}/study?activity=${encodeURIComponent(currentActivity.id)}`} data-today-primary-cta="true">继续：{currentActivity.intentSummary}</Link> : currentActivity ? (
              <button
                type="button"
                className={buttonClass}
                data-today-primary-cta="true"
                onClick={() => void runPrimaryCta()}
                disabled={ctaBusy || activityLoad === "loading"}
              >
                {ctaBusy ? "处理中…" : ctaLabel}
              </button>
            ) : null}
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
        <div className={`flex min-h-0 flex-1 flex-col lg:grid ${showDesktopQueue ? "lg:grid-cols-[260px_minmax(0,1fr)]" : "lg:grid-cols-1"} lg:grid-rows-1 group-data-[focus=true]/workspace:lg:grid-cols-1`}>
          <div
            id="today-queue"
            className={`${queueOpen ? "flex" : "hidden"} max-h-72 min-h-0 shrink-0 flex-col overflow-y-auto border-b border-zinc-200 bg-zinc-50 ${showDesktopQueue ? "lg:flex" : ""} lg:max-h-none lg:border-b-0 lg:border-r group-data-[focus=true]/workspace:hidden`}
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
              onEmptyChange={setQueueEmpty}
              api={api}
              focusTaskId={focusTaskId}
              selectedId={task?.id}
              onSelect={select}
              onClearSelection={clearSelection}
              reloadToken={reloadToken}
              timeZone={timeZone}
            />
          </div>
          <div
            ref={teachingPaneRef}
            className="min-h-0 min-w-0 flex-1 bg-white"
            data-today-teaching-pane="true"
            data-today-cta-focus={ctaFocusNonce > 0 ? String(ctaFocusNonce) : undefined}
          >
            {currentActivity ? (
              currentActivity.courseId ? <div className="mx-auto max-w-3xl space-y-3 px-5 py-6"><h2 className="text-lg font-semibold">{currentActivity.intentSummary}</h2><p className="text-xs leading-6 text-zinc-500">进入课程工作区，恢复原学习断点、材料、提问与笔记。</p><Link className={buttonClass} href={`/opening/courses/${encodeURIComponent(currentActivity.courseId)}/study?activity=${encodeURIComponent(currentActivity.id)}`}>进入学习工作区</Link></div> : teachingLoopTrialEnabled ? (
                <TeachingContinueEntry
                  key={`${currentActivity.id}:${ctaFocusNonce}`}
                  activity={currentActivity}
                  contextualTools={context => <CourseStudyContextTools context={context} />}
                  resume={learningResume}
                  assistantHref={assistantHref}
                  timeZone={timeZone}
                  api={api}
                  initialClientInit={clientInit}
                  teachingCompileEnabled={teachingCompileEnabled}
                  startInWorkspace={ctaPreferWorkspace && ctaFocusNonce > 0}
                  onActivityUpdated={(next) => {
                    setSelectedActivity(next);
                    setActivities((rows) =>
                      rows.map((row) => (row.id === next.id ? next : row)),
                    );
                  }}
                />
              ) : (
                <TeachingLoopTrialEmpty
                  assistantHref={assistantHref}
                  loopEnabled={teachingLoopEnabled}
                  workspaceEnabled={teachingWorkspaceEnabled}
                />
              )
            ) : (
              <TeachingActivityEmpty
                onStart={() => void runPrimaryCta()}
                busy={ctaBusy}
                error={ctaError}
                assistantHref={assistantHref}
              />
            )}
            {teachingLoopTrialEnabled &&
            currentActivity &&
            resumeLoad === "error" &&
            clientInitLoad === "error" ? (
              <p className="px-5 pb-4 text-[11px] text-amber-800" role="status">
                学习断点与主讲内容暂时无法读取；已回退到活动摘要，不会伪造讲义。
              </p>
            ) : null}
          </div>
        </div>
      </div>
      </TaskLearningActionContext.Provider>
    </TaskQueueRefreshContext.Provider>
  );
}
