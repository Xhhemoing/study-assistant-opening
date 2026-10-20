"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, CalendarPlus } from "lucide-react";
import { createOpeningApi, type OpeningApi } from "../opening/client/api";
import { useOpeningCapabilities } from "../opening/capabilities/capabilities-provider";
import { ui } from "../opening/design/ui";
import { runSeedTodayPlan } from "../opening/planning/seed-today-plan";
import { courseActivityNextStep, courseStudyActivities, courseStudyHref, courseStudyTasks, currentCourseActivity } from "./course-study-model";
import { useCourseStudy } from "./use-course-study";

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
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const capabilities = useOpeningCapabilities();
  const enabled = opening && Boolean(courseId) && capabilities.teachingLoop.api && capabilities.teachingLoop.ui;
  const study = useCourseStudy(courseId ?? "", api, enabled, opening && Boolean(courseId) && capabilities.adaptivePlanning);
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
    <section className="border-b border-zinc-200 pb-5" aria-labelledby="course-study-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="course-study-heading" className="text-sm font-semibold text-zinc-800">{current ? "当前学习" : "下一步"}</h2>
        <p className="text-xs text-zinc-500">{countText}</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">
        {archived ? "课程已归档，可以阅读材料与查看记录。恢复课程后可继续学习。" : current ? current.intentSummary : tasks[0]?.title ?? "选择一个主题即可开始；也可以直接读材料或记笔记。"}
      </p>
      {current ? <p className="mt-1 text-xs leading-6 text-zinc-500">{courseActivityNextStep(current)}</p> : null}
      {study.goal ? <p className="mt-1 text-xs leading-6 text-zinc-500">课程目标：{study.goal.targetDate ? `截至 ${study.goal.targetDate}` : "长期学习"} · 每周 {study.goal.weeklyMinutes} 分钟{study.goal.milestones?.length ? ` · ${study.goal.milestones.filter(item => item.status === "confirmed_by_learner").length}/${study.goal.milestones.length} 项成果由你确认` : ""}</p> : opening && capabilities.adaptivePlanning && !study.taskError ? <p className="mt-1 text-xs text-zinc-500">未设置目标也可以开始。</p> : null}
      <nav aria-label="课程学习方式" className="mt-3 flex flex-wrap items-center gap-2">
        {opening && courseId ? <Link className={ui.primary} href={archived ? "#course-learning-records" : studyHref}>
          {archived ? "查看学习记录" : study.loading ? "打开学习" : current ? "继续学习" : enabled ? "开始学习" : "开始独立练习"}<ArrowRight size={14} aria-hidden="true" />
        </Link> : <a className={ui.primary} href="#course-practice">开始独立练习<ArrowRight size={14} aria-hidden="true" /></a>}
        <Link className={ui.quiet} href={opening ? `/opening/library?tab=materials${courseId ? `&courseId=${encodeURIComponent(courseId)}` : ""}` : "/library?tab=materials"}>读材料</Link>
        <Link className={ui.quiet} href={opening ? `/opening/library/new${courseId ? `?courseId=${encodeURIComponent(courseId)}` : ""}` : "/library/new"}>写笔记</Link>
      </nav>
      {study.loading ? <p role="status" className="mt-2 text-xs text-zinc-500">正在确认本课程的学习位置…</p> : null}
      {study.error ? <p role="alert" className="mt-2 text-xs text-amber-800">{study.error} <button type="button" className={ui.quiet} onClick={study.reload}>重新读取</button></p> : null}
      {study.taskError ? <p role="status" className="mt-2 text-xs text-amber-800">{study.taskError}</p> : null}
      {opening && !enabled ? <p className="mt-2 text-xs leading-5 text-zinc-500">当前可直接进入独立练习，或阅读课程材料。</p> : null}
      {courseActivities.length ? <p className="mt-2 text-xs text-zinc-500">{courseActivities.filter(item => item.status === "completed").length} 次活动已结束 · {tasks.length} 项待办；活动完成不等于已掌握。</p> : null}
      {enabled && !archived && (tasks.length || courseActivities.filter(item => item.status === "active" || item.status === "paused").length > 1) ? <details className="mt-3 text-xs text-zinc-500"><summary className="cursor-pointer py-1 focus-visible:ring-2 focus-visible:ring-emerald-700">选择其他任务或学习活动</summary><ul className="mt-2 space-y-2">{tasks.map(task => <li key={task.id}><Link className="text-emerald-800 underline underline-offset-4" href={`${courseStudyHref(courseId!)}?task=${encodeURIComponent(task.id)}`}>{task.title} · {task.minutes} 分钟</Link></li>)}{courseActivities.filter(item => item.status === "active" || item.status === "paused").map(item => <li key={item.id}><Link className="text-emerald-800 underline underline-offset-4" href={courseStudyHref(courseId!, item.id)}>继续：{item.intentSummary}</Link></li>)}</ul></details> : null}
      {canSeed ? <details className="mt-4 text-xs text-zinc-500"><summary className="cursor-pointer py-1 focus-visible:ring-2 focus-visible:ring-emerald-700">学习安排与其他入口</summary><div className="mt-2 flex flex-wrap items-center gap-2">
        {canSeed ? (
          <button
            type="button"
            className={ui.secondary}
            disabled={busy}
            onClick={() => void seedTodayPlan()}
          >
            <CalendarPlus size={14} aria-hidden="true" />
            {busy ? "正在设置…" : "设为今日计划"}
          </button>
        ) : null}
        <Link className={ui.quiet} href="/opening/today">查看今日计划</Link>
      </div><p className="mt-2 leading-5">设为今日计划会补充默认作息并添加今日任务，确认草案后再开始。</p></details> : null}
      {error ? (
        <p className="mt-2 text-xs leading-5 text-red-700" role="alert">{error}</p>
      ) : null}
    </section>
  );
}
