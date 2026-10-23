"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TaskQueueRefreshContext } from "./task-status-control";
import { buttonClass, EmptyState, ui } from "../design/ui";
import type { OpeningApi } from "../client/api";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { useDueReviewCount } from "../shell/review-count";
import { TodayProgress } from "./today-progress";
import { currentTodayCourse, hasNoTodayCourses, type TodayResumeState } from "./today-read";
import { TodayNoCourses, TodayResumeBody } from "./today-resume-view";
import { localDateKey, resolveTodayTimeZone, TodayPlanView } from "./today-view";
import type { StudyTask } from "./study-task";
import { CourseStudyContextTools } from "../../courses/course-study-context-tools";
import { TodayLearningContext } from "./today-overview";
import type { ActivitySpecClientInit, LearningResume, TeachingActivity } from "@aistudy/contracts";
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
import { ReviewView } from "./review-view";
import { useNextStepMetrics } from "./use-next-step-metrics";
import { PageHeader as V3PageHeader } from "../v3/shell/page-header";
import { ASSISTANT_OPEN_EVENT } from "../assistant/assistant-entry";
import { Sparkles } from "lucide-react";

/** 一键学习会话入口：连续复习 → 当前学习单元。 */
export function todaySessionHref(next: { href: string; label: string }): string {
  return `/opening/review?${new URLSearchParams({ tab: "session", next: next.href, nextLabel: next.label.slice(0, 60) })}`;
}

/** 「10月23日 周五」：比 ISO 日期更易读；时区与今日计划一致。 */
export function friendlyTodayLabel(date: Date, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short", timeZone }).format(date).replace(/\s+/g, " ");
  } catch {
    return localDateKey(date, timeZone);
  }
}

/** 开始页的 AI 入口：一处输入框外观的按钮，打开学习助手。 */
export function TodayAskBar() {
  const open = () => window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT, { detail: "/opening/assistant" }));
  return <div className="px-4 pb-2 sm:px-5" data-today-ask="true">
    <div className="flex items-center gap-2 rounded-panel border border-line bg-surface p-1.5 px-4 shadow-[0_1px_2px_rgb(0_0_0/.04)]">
      <Sparkles aria-hidden="true" size={16} className="shrink-0 text-ai-2" />
      <button type="button" onClick={open} className="min-h-10 min-w-0 flex-1 truncate text-left text-ui text-text-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">问 AI：概念、题目或资料里的任何一段</button>
    </div>
  </div>;
}



/** Visible outcome when the Today primary CTA runs with/without an existing activity. */
export type TodayPrimaryCtaPlan =
  | { kind: "create" }
  | { kind: "setup" }
  | {
      kind: "focus-existing";
      activityId: string;
      /** Open workspace immediately when clientInit is already usable. */
      preferWorkspace: boolean;
    };

export function planTodayPrimaryCta(
  existing: TeachingActivity | null,
  clientInit: ActivitySpecClientInit | null | undefined,
  hasLearningContext = true,
): TodayPrimaryCtaPlan {
  if (!existing) return { kind: hasLearningContext ? "create" : "setup" };
  const preferWorkspace = Boolean(
    clientInit && isTeachingWorkspaceContentUsable(existing, clientInit),
  );
  return { kind: "focus-existing", activityId: existing.id, preferWorkspace };
}

export function shouldOpenTodayQueue(focusTaskId?: string): boolean {
  return Boolean(focusTaskId);
}

export function TodayDashboard({
  state,
  api: apiProp,
  focusTaskId,
  planning = false,
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
  /** Scheduling lives in Settings; Today mounts only learning and progress. */
  planning?: boolean;
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
  const [queueOpen, setQueueOpen] = useState(() => planning || shouldOpenTodayQueue(focusTaskId));
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [pendingReviewCount, setPendingReviewCount] = useState(state.pendingReviews?.count ?? 0);
  const [reloadToken, setReloadToken] = useState(0);
  const dueCardCount = useDueReviewCount(planning ? "/opening/settings/planning" : "/opening/today") ?? 0;
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
  const rereadQueue = useCallback(() => { setReloadToken((value) => value + 1); }, []);
  const currentActivity = selectedActivity ?? pickCurrentTeachingActivity(activities);
  const noCourses = hasNoTodayCourses(state);
  const currentCourse = currentTodayCourse(state, currentActivity);
  const nextStepMetrics = useNextStepMetrics(currentActivity ? { targetType: "activity", targetId: currentActivity.id }
    : state.kind === "ready" && state.continueItem ? { targetType: "conversation", targetId: state.continueItem.conversationId }
      : currentCourse ? { targetType: "course", targetId: currentCourse.id } : null);
  const courseTitle = currentCourse?.title;
  const ctaLabel = todayActivityCtaLabel(pickCurrentTeachingActivity(activities));
  const assistantHref = state.continueItem
    ? `/opening/assistant?conversation=${encodeURIComponent(state.continueItem.conversationId)}`
    : "/opening/assistant";

  useEffect(() => {
    if (focusTaskId) setQueueOpen(true);
  }, [focusTaskId]);
  useEffect(() => {
    if (!planning) {
      if (window.location.hash === "#suggestions") window.location.replace("/opening/settings/planning#suggestions");
      return;
    }
    const openSuggestions = () => { if (window.location.hash === "#suggestions") setReviewsOpen(true); };
    const showSuggestions = () => setReviewsOpen(true);
    openSuggestions(); window.addEventListener("hashchange", openSuggestions);
    window.addEventListener("opening:show-suggestions", showSuggestions);
    return () => { window.removeEventListener("hashchange", openSuggestions); window.removeEventListener("opening:show-suggestions", showSuggestions); };
  }, [planning]);

  useEffect(() => {
    if (noCourses || state.kind !== "ready" && state.kind !== "empty") return;
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
  }, [api, reloadToken, state.kind, noCourses]);

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
  const select = useCallback((next: StudyTask) => {
    setTask(next);
  }, []);
  const taskStartInFlight = useRef(false);

  const runPrimaryCta = useCallback(async () => {
    if (taskStartInFlight.current) return;
    setCtaError(null);
    const existing = pickCurrentTeachingActivity(activities);
    const plan = planTodayPrimaryCta(existing, clientInit, Boolean(state.continueItem));
    if (plan.kind === "setup") {
      window.location.assign("/onboarding");
      return;
    }
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
      setCtaFocusNonce((n) => n + 1);
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
      if (planning && created.courseId) window.location.assign(`/opening/courses/${encodeURIComponent(created.courseId)}/study?activity=${encodeURIComponent(created.id)}`);
    } catch (reason) { setCtaError(reason instanceof Error ? reason.message : "任务主讲创建未确认，请用同一任务重新读取。"); }
    finally { taskStartInFlight.current = false; setCtaBusy(false); }
  }, [api, planning, teachingLoopTrialEnabled, timeZone]);


  useEffect(() => {
    if (ctaFocusNonce === 0) return;
    const reducedMotion = document.documentElement.dataset.motion === "reduce" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    teachingPaneRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }, [ctaFocusNonce]);

  if (state.kind === "loggedOut" || state.kind === "error") {
    return <TodayResumeBody state={state} />;
  }
  // F1 一键学习会话：有到期卡片时，主按钮先进入连续复习，完成后直接接到当前学习单元。
  const sessionStudy = currentActivity?.courseId
    ? { href: `/opening/courses/${encodeURIComponent(currentActivity.courseId)}/study?activity=${encodeURIComponent(currentActivity.id)}`, label: currentActivity.intentSummary }
    : !currentActivity && currentCourse ? { href: `/opening/courses/${encodeURIComponent(currentCourse.id)}/study`, label: currentCourse.title } : null;
  const sessionPrimary = sessionStudy && dueCardCount > 0
    ? <Link className={buttonClass} data-today-primary-cta="true" data-today-session="true" href={todaySessionHref(sessionStudy)}>开始学习 · 先复习 {dueCardCount} 张卡</Link>
    : null;
  const heading = <div className="group-data-[focus=true]/workspace:hidden"><V3PageHeader title={planning ? "学习安排" : "今日学习"} fact={<time dateTime={localDateKey(new Date(), timeZone)}>{friendlyTodayLabel(new Date(), timeZone)}</time>} /></div>;
  const suggestions = <details id="suggestions" open={reviewsOpen} onToggle={event => setReviewsOpen(event.currentTarget.open)} className={`mx-5 mb-5 rounded-xl border border-line bg-surface ${reviewsOpen ? "" : pendingReviewCount === 0 ? "hidden" : "group-data-[focus=true]/workspace:hidden"}`}>
    <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">待确认建议{pendingReviewCount > 0 ? ` · ${pendingReviewCount}` : ""}</summary>
    <ReviewView api={api} embedded onPendingCountChange={setPendingReviewCount} onDecision={rereadQueue} />
  </details>;
  if (noCourses && !planning) return <div className="min-h-full bg-bg text-text">{heading}<TodayNoCourses /><nav aria-label="今日其他安排" className="px-5 pb-4"><Link href="/opening/review" className={ui.quiet}>复习</Link></nav></div>;

  return (
    <TaskQueueRefreshContext.Provider value={rereadQueue}>
      <TaskLearningActionContext.Provider value={teachingLoopTrialEnabled ? { start: (selected) => { void startTaskLearning(selected); }, busy: ctaBusy } : null}>
      <div className="flex min-h-full flex-col bg-bg text-text">
        {heading}
        {state.courses?.status === "error" ? <p role="status" className="px-5 pt-3 text-xs text-warn">课程暂时无法读取。<Link className={ui.quiet} href="/opening/today">重新读取</Link></p> : null}
        {!planning ? <div ref={nextStepMetrics.ref} onClickCapture={event => {
          if ((event.target as Element).closest('[data-today-primary-cta="true"]')) nextStepMetrics.clicked();
        }} className={`shrink-0 ${ctaFocusNonce > 0 && !currentActivity?.courseId ? "group-data-[focus=true]/workspace:hidden" : ""}`}>
          {currentActivity || state.continueItem || currentCourse ? <TodayLearningContext
            item={state.continueItem}
            courseTitle={courseTitle}
            course={currentCourse}
            timeZone={timeZone}
            activity={currentActivity ? { title: currentActivity.intentSummary, courseId: currentActivity.courseId, id: currentActivity.id, contentVersion: currentActivity.contentVersion } : null}
            resume={learningResume}
            primaryAction={sessionPrimary ?? (currentActivity?.courseId ? <Link className={buttonClass} href={`/opening/courses/${encodeURIComponent(currentActivity.courseId)}/study?activity=${encodeURIComponent(currentActivity.id)}`} data-today-primary-cta="true">继续：{currentActivity.intentSummary}</Link> : currentActivity ? (
              <button
                type="button"
                className={buttonClass}
                data-today-primary-cta="true"
                onClick={() => void runPrimaryCta()}
                disabled={ctaBusy || activityLoad === "loading"}
              >
                {ctaBusy ? "处理中…" : ctaLabel}
              </button>
            ) : state.continueItem ? <button type="button" className={buttonClass} data-today-primary-cta="true" disabled={ctaBusy || activityLoad === "loading"} onClick={() => void runPrimaryCta()}>{ctaBusy ? "处理中…" : "开始学习"}</button> : currentCourse ? <Link className={buttonClass} href={`/opening/courses/${encodeURIComponent(currentCourse.id)}/study`} data-today-primary-cta="true">开始学习</Link> : null)}
            secondaryAction={
              <Link href={assistantHref} className={ui.quiet}>
                自由对话
              </Link>
            }
          /> : activityLoad === "loading" ? <p role="status" className="px-5 py-8 text-sm text-text-2">正在读取…</p> : activityLoad === "ready" ? <EmptyState title="从课程继续学习" description="选择一门课程，开始阅读或练习。" action={<Link className={buttonClass} href="/opening/courses">选择课程</Link>} /> : null}
          <TodayAskBar />
          {ctaError ? (
            <p className="px-4 text-xs text-danger sm:px-5" role="alert">{ctaError}</p>
          ) : null}
          {activityLoad === "error" ? (
            <p className="px-4 text-xs text-warn sm:px-5" role="status">
              学习记录暂时无法读取。<button type="button" className={ui.quiet} onClick={rereadQueue}>重新读取</button>
            </p>
          ) : null}
        </div> : ctaError ? <p role="alert" className="px-5 pt-3 text-sm text-danger">{ctaError}</p> : null}
        {!planning ? <TodayProgress api={api} timeZone={timeZone} reloadToken={reloadToken} /> : null}
        <div className="flex min-h-0 flex-1 flex-col">
          <nav aria-label="今日其他安排" className={`flex flex-wrap items-center gap-2 px-5 py-3 ${queueOpen ? "" : "group-data-[focus=true]/workspace:hidden"}`}>
            {planning ? <button type="button" className={ui.quiet} aria-expanded={queueOpen} aria-controls="today-queue" onClick={() => setQueueOpen(open => !open)}>{queueOpen ? "收起任务列表" : "查看任务列表"}</button> : <Link href="/opening/settings/planning" className={ui.quiet}>学习安排</Link>}
            {planning ? <><Link href="/opening/today" className={ui.quiet}>返回今天</Link><Link href="/opening/review" className={ui.quiet}>复习</Link></> : null}
          </nav>
          {planning ? <div
            id="today-queue"
            hidden={!queueOpen}
            className={`${queueOpen ? "flex" : "hidden"} min-h-0 shrink-0 flex-col border-b border-line bg-surface`}
          >
            <TodayPlanView
              api={api}
              focusTaskId={focusTaskId}
              selectedId={task?.id}
              onSelect={select}
              onClearSelection={clearSelection}
              reloadToken={reloadToken}
              timeZone={timeZone}
            />
          </div> : null}
          <div
            ref={teachingPaneRef}
            className={`min-h-0 min-w-0 flex-1 ${currentActivity && ctaFocusNonce > 0 && !currentActivity.courseId ? "bg-surface" : ""}`}
            data-today-teaching-pane="true"
            data-today-cta-focus={ctaFocusNonce > 0 ? String(ctaFocusNonce) : undefined}
          >
            {currentActivity && ctaFocusNonce > 0 ? (
              currentActivity.courseId ? null : teachingLoopTrialEnabled ? (
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
            ) : null}
            {teachingLoopTrialEnabled &&
            currentActivity &&
            resumeLoad === "error" &&
            clientInitLoad === "error" ? (
              <p className="px-5 pb-4 text-xs text-warn" role="status">
                学习内容暂时无法读取。<button type="button" className={ui.quiet} onClick={rereadQueue}>重新读取</button>
              </p>
            ) : null}
          </div>
        </div>
        {planning ? suggestions : null}
      </div>
      </TaskLearningActionContext.Provider>
    </TaskQueueRefreshContext.Provider>
  );
}
