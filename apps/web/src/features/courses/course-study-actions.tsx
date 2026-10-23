"use client";

import Link from "next/link";
import { localDateKeyInZone, resolveGoalLearningContext } from "@aistudy/domain";
import { useRouter } from "next/navigation";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, CalendarPlus } from "lucide-react";
import { createOpeningApi, type OpeningApi } from "../opening/client/api";
import { useOpeningCapabilities } from "../opening/capabilities/capabilities-provider";
import { useConversationObjectHref } from "../opening/assistant/conversation-object-context";
import { ui } from "../opening/design/ui";
import { runSeedTodayPlan } from "../opening/planning/seed-today-plan";
import { courseStudyActivities, courseStudyHref, courseStudyTasks, currentCourseActivity } from "./course-study-model";
import { useCourseStudy } from "./use-course-study";

const CourseStudyContext = createContext<ReturnType<typeof useCourseStudy> | null>(null);

export function useCourseStudySummary() { return useContext(CourseStudyContext); }

/** One real course read feeds the overview and unit list across tab changes. */
export function CourseStudyProvider({ courseId, children }: { courseId: string; children: ReactNode }) {
  const api = useMemo(() => createOpeningApi(), []);
  const capabilities = useOpeningCapabilities();
  const study = useCourseStudy(courseId, api, capabilities.teachingLoop.api && capabilities.teachingLoop.ui);
  return <CourseStudyContext.Provider value={study}>{children}</CourseStudyContext.Provider>;
}

export function CourseStudyAlternatives({ courseId, archived }: { courseId: string; archived: boolean }) {
  const objectHref = useConversationObjectHref();
  const study = useContext(CourseStudyContext);
  if (!study || archived) return null;
  const tasks = courseStudyTasks(study.tasks, courseId);
  const activities = courseStudyActivities(study.activities, courseId).filter(item => item.status === "active" || item.status === "paused");
  if (!tasks.length && !activities.length && !study.error && !study.taskError) return null;
  return <section className="space-y-3" aria-label="课程任务与学习活动">
    <h2 className="text-base font-semibold">课程任务与学习活动</h2>
    <ul className="space-y-2 text-sm">{tasks.map(task => <li key={task.id}><Link className={ui.quiet} href={objectHref(`${courseStudyHref(courseId)}?task=${encodeURIComponent(task.id)}`)}>{task.title} · {task.minutes} 分钟</Link></li>)}{activities.map(item => <li key={item.id}><Link className={ui.quiet} href={objectHref(courseStudyHref(courseId, item.id))}>继续：{item.intentSummary}</Link></li>)}</ul>
    {study.error || study.taskError ? <p className="text-xs text-warn" role="status">{study.error || study.taskError}<button type="button" className={ui.quiet} onClick={study.reload}>重新读取</button></p> : null}
  </section>;
}

/** Primary learning CTA only; materials / records stay secondary (CT-01 / CT-02). */
export function CourseStudyActions({
  assetCount,
  goalCount,
  opening = false,
  courseId,
  courseTitle,
  archived = false,
  api: suppliedApi,
}: {
  assetCount: number;
  goalCount?: number;
  opening?: boolean;
  courseId?: string;
  courseTitle?: string;
  archived?: boolean;
  api?: OpeningApi;
}) {
  const router = useRouter();
  const objectHref = useConversationObjectHref();
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const capabilities = useOpeningCapabilities();
  const enabled = opening && Boolean(courseId) && capabilities.teachingLoop.api && capabilities.teachingLoop.ui;
  const inherited = useContext(CourseStudyContext);
  const localStudy = useCourseStudy(courseId ?? "", api, !inherited && enabled, !inherited && opening && Boolean(courseId));
  const study = inherited ?? localStudy;
  const goalContext = study.timeZone && study.goal ? resolveGoalLearningContext(study.goal, localDateKeyInZone(new Date(), study.timeZone)) : null;
  const current = courseId ? currentCourseActivity(study.activities, courseId) : null;
  const courseActivities = courseId ? courseStudyActivities(study.activities, courseId) : [];
  const tasks = courseId ? courseStudyTasks(study.tasks, courseId) : [];
  const studyHref = courseId ? current ? courseStudyHref(courseId, current.id) : tasks[0] ? `${courseStudyHref(courseId)}?task=${encodeURIComponent(tasks[0].id)}` : courseStudyHref(courseId) : "#course-practice";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const countText =
    typeof goalCount === "number"
      ? `${assetCount} 份课程材料 · ${goalCount} 个学习目标`
      : `${assetCount} 份课程材料`;
  const canSeed = Boolean(opening && courseId && courseTitle && !archived);

  async function seedTodayPlan() {
    if (!canSeed || !courseId || !courseTitle || busy) return;
    setBusy(true);
    setError("");
    try {
      await runSeedTodayPlan(api, {
        target: { kind: "course", courseId, courseTitle },
        navigate: (href) => router.push(href),
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设为今日计划失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-b border-line pb-5" aria-labelledby="course-study-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="course-study-heading" className="text-sm font-semibold text-text">{current ? "当前学习" : "下一步"}</h2>
        <p className="text-xs text-text-3">{countText}</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-text-2">
        {archived ? "课程已归档。" : current ? current.intentSummary : tasks[0]?.title ?? "从第一个主题开始。"}
      </p>
      {study.goal ? <p className="mt-1 text-xs leading-6 text-text-3">课程目标：{study.goal.targetDate ? `截至 ${study.goal.targetDate}` : "长期学习"} · 每周 {study.goal.weeklyMinutes} 分钟{study.goal.milestones?.length ? ` · ${study.goal.milestones.filter(item => item.status === "confirmed_by_learner").length}/${study.goal.milestones.length} 项成果由你确认` : ""}</p> : null}
      {opening && courseId && !archived && goalContext?.mode === "exam" ? <p className="mt-2 text-sm text-accent">已进入考前练习{goalContext.daysRemaining !== null ? ` · 距目标 ${goalContext.daysRemaining} 天` : ""} <Link className={ui.quiet} href={objectHref(`/opening/courses/${courseId}/exam`)}>开始考前练习</Link></p> : null}
      <nav aria-label="课程学习方式" className="mt-3 flex flex-wrap items-center gap-2">
        {opening && courseId ? <Link className={ui.primary} href={archived ? "#course-learning-records" : objectHref(studyHref)}>
          {archived ? "查看学习记录" : study.loading ? "打开学习" : current ? "继续学习" : enabled ? "开始学习" : "开始独立练习"}<ArrowRight size={14} aria-hidden="true" />
        </Link> : <a className={ui.primary} href="#course-practice">开始独立练习<ArrowRight size={14} aria-hidden="true" /></a>}
        <Link className={ui.quiet} href={objectHref(opening ? `/opening/library?tab=materials${courseId ? `&courseId=${encodeURIComponent(courseId)}` : ""}` : "/library?tab=materials")}>读材料</Link>
        <Link className={ui.quiet} href={opening ? `/opening/library/new${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}` : "/library/new"}>写笔记</Link>
        {canSeed ? <button type="button" className={ui.quiet} disabled={busy} onClick={() => void seedTodayPlan()}><CalendarPlus size={14} aria-hidden="true" />{busy ? "正在设置…" : "设为今日计划"}</button> : null}
      </nav>
      {study.loading ? <p role="status" className="mt-2 text-xs text-text-3">正在确认本课程的学习位置…</p> : null}
      {study.error ? <p role="alert" className="mt-2 text-xs text-warn">{study.error} <button type="button" className={ui.quiet} onClick={study.reload}>重新读取</button></p> : null}
      {study.taskError ? <p role="status" className="mt-2 text-xs text-warn">{study.taskError}</p> : null}
            {courseActivities.length ? <p className="mt-2 text-xs text-text-3">{courseActivities.filter(item => item.status === "completed").length} 次学习已结束 · {tasks.length} 项待办。</p> : null}
      {enabled && !archived && (tasks.length || courseActivities.filter(item => item.status === "active" || item.status === "paused").length > 1) ? <a className={`${ui.quiet} mt-2`} href="#course-units">选择其他任务或学习活动</a> : null}
      
      {error ? (
        <p className="mt-2 text-xs leading-5 text-danger" role="alert">{error}</p>
      ) : null}
    </section>
  );
}
