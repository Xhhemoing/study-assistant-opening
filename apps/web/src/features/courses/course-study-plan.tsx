"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarRange, CircleCheck, CircleDot, Square } from "lucide-react";
import type { CourseStudyPlanLesson, CourseStudyPlanView } from "@aistudy/contracts";
import { localDateKeyInZone } from "@aistudy/domain";
import { createOpeningApi, type OpeningApi } from "../opening/client/api";
import { ui } from "../opening/design/ui";
import { ensurePlanningSettings, SEED_TODAY_TIME_ZONE } from "../opening/planning/seed-today-plan";

const LESSONS_PER_DAY = [1, 2, 3, 4, 5, 6] as const;
const LESSON_MINUTES = [25, 45, 60, 90] as const;

function shortDate(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

/** One line on pace: lesson count, finish day, review days, and whether the target fits. */
export function studyPlanSummary(view: CourseStudyPlanView): string {
  if (!view.plan) return `材料可分成 ${view.lessons.length} 课。设定每天学几节，系统会每天自动排好当天的课和复习。`;
  const taught = view.lessons.filter((lesson) => lesson.status === "taught").length;
  const finish = view.finishDate ? `预计 ${shortDate(view.finishDate)} 学完新内容` : "按这个节奏 90 天内排不完";
  const reviews = view.reviewDates.length ? `；之后按第 1、3、7 天安排复习（下次 ${shortDate(view.reviewDates[0]!)}）` : "";
  return `共 ${view.lessons.length} 课，已学 ${taught} 课；每天 ${view.plan.lessonsPerDay} 节、每节 ${view.plan.lessonMinutes} 分钟，${finish}${reviews}。`;
}

export function lessonStatusLabel(lesson: CourseStudyPlanLesson): string {
  switch (lesson.status) {
    case "taught": return lesson.date ? `${shortDate(lesson.date)} 已学` : "已学";
    case "today": return "今天";
    case "planned": return lesson.date ? shortDate(lesson.date) : "已排";
    default: return "未排上";
  }
}

function pages(lesson: CourseStudyPlanLesson): string {
  if (lesson.pageFrom == null) return "";
  return lesson.pageFrom === lesson.pageTo ? `第 ${lesson.pageFrom} 页` : `第 ${lesson.pageFrom}–${lesson.pageTo} 页`;
}

function StatusIcon({ status }: { status: CourseStudyPlanLesson["status"] }) {
  if (status === "taught") return <CircleCheck size={14} className="shrink-0 text-emerald-700" aria-hidden="true" />;
  if (status === "today") return <CircleDot size={14} className="shrink-0 text-amber-700" aria-hidden="true" />;
  return <Square size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />;
}

/** Plan body; separated from data loading so it renders statically in tests. */
export function CourseStudyPlanContent({
  view, busy, error, onSave, onStop, today,
}: {
  view: CourseStudyPlanView;
  busy: boolean;
  error: string;
  today: string;
  onSave: (input: { lessonsPerDay: number; lessonMinutes: number; targetDate: string | null }) => void;
  onStop: () => void;
}) {
  const [lessonsPerDay, setLessonsPerDay] = useState(view.plan?.lessonsPerDay ?? 3);
  const [lessonMinutes, setLessonMinutes] = useState(view.plan?.lessonMinutes ?? 45);
  const [targetDate, setTargetDate] = useState(view.targetDate ?? "");
  if (view.noMaterial) {
    return <p className="mt-2 text-sm leading-6 text-zinc-600">上传并解析课程材料后，可以按材料自动分课、每天排课和安排复习。</p>;
  }
  return (
    <>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600" data-study-plan-summary>{studyPlanSummary(view)}</p>
      {view.plan && view.behind && view.targetDate ? (
        <p className="mt-1 text-xs leading-5 text-amber-800" role="status">按这个节奏赶不上 {shortDate(view.targetDate)} 的截止日，可以增加每天的节数。</p>
      ) : null}
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(event) => { event.preventDefault(); onSave({ lessonsPerDay, lessonMinutes, targetDate: targetDate || null }); }}
      >
        <label className="grid gap-1 text-xs text-zinc-600">
          每天学几节
          <select className={ui.input} value={lessonsPerDay} onChange={(event) => setLessonsPerDay(Number(event.target.value))} disabled={busy}>
            {LESSONS_PER_DAY.map((n) => <option key={n} value={n}>{n} 节</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-zinc-600">
          每节时长
          <select className={ui.input} value={lessonMinutes} onChange={(event) => setLessonMinutes(Number(event.target.value))} disabled={busy}>
            {LESSON_MINUTES.map((n) => <option key={n} value={n}>{n} 分钟</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-zinc-600">
          截止日期（可选）
          <input className={ui.input} type="date" min={today} value={targetDate} onChange={(event) => setTargetDate(event.target.value)} disabled={busy} />
        </label>
        <button type="submit" className={ui.primary} disabled={busy}>
          <CalendarRange size={14} aria-hidden="true" />
          {busy ? "正在保存…" : view.plan ? "更新计划" : "生成学习计划"}
        </button>
        {view.plan ? (
          <>
            <Link className={ui.quiet} href="/opening/today">去今日学习<ArrowRight size={14} aria-hidden="true" /></Link>
            <button type="button" className={ui.quiet} disabled={busy} onClick={onStop}>停止计划</button>
          </>
        ) : null}
      </form>
      {error ? <p className="mt-2 text-xs leading-5 text-red-700" role="alert">{error}</p> : null}
      <ol className="mt-3 divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-900/5" aria-label="课程分课">
        {view.lessons.map((lesson) => (
          <li key={lesson.number} className="flex items-start gap-2 px-3 py-2 text-sm" data-study-plan-lesson={lesson.status}>
            <span className="mt-0.5"><StatusIcon status={lesson.status} /></span>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-zinc-800">第 {lesson.number} 课</span>
              <span className="ml-2 text-zinc-700">{lesson.title}</span>
              {pages(lesson) ? <span className="ml-2 text-xs text-zinc-500">{pages(lesson)}</span> : null}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-zinc-500">{lessonStatusLabel(lesson)}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs leading-5 text-zinc-500">
        每天打开「今日」会自动加上当天的课：先复习 1、3、7 天前学过的课和答错的题，再学新课。只学了一部分也没关系，没学完的课会顺延。
      </p>
    </>
  );
}

/** Course page: split the course material into lessons and schedule them a few a day. */
export function CourseStudyPlan({ courseId, api: suppliedApi }: { courseId: string; api?: OpeningApi }) {
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const [view, setView] = useState<CourseStudyPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const today = localDateKeyInZone(new Date(), SEED_TODAY_TIME_ZONE);

  useEffect(() => {
    let current = true;
    api.getCourseStudyPlan(courseId).then(
      (loaded) => { if (current) setView(loaded); },
      (reason) => { if (current) setError(reason instanceof Error ? reason.message : "读取学习计划失败。"); },
    );
    return () => { current = false; };
  }, [api, courseId]);

  async function save(plan: { lessonsPerDay: number; lessonMinutes: number; targetDate: string | null } | null) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (plan) await ensurePlanningSettings(api);
      setView(await api.putCourseStudyPlan(courseId, {
        plan: plan ? { lessonsPerDay: plan.lessonsPerDay, lessonMinutes: plan.lessonMinutes, startDate: view?.plan?.startDate ?? today } : null,
        targetDate: plan?.targetDate ?? null,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存学习计划失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-b border-zinc-200 py-5" aria-labelledby="course-study-plan-heading">
      <h2 id="course-study-plan-heading" className="text-sm font-semibold text-zinc-800">学习计划</h2>
      {view ? (
        <CourseStudyPlanContent
          key={view.plan ? `${view.plan.lessonsPerDay}-${view.plan.lessonMinutes}` : "none"}
          view={view} busy={busy} error={error} today={today}
          onSave={(input) => void save(input)} onStop={() => void save(null)}
        />
      ) : error ? <p className="mt-2 text-xs leading-5 text-red-700" role="alert">{error}</p> : <p className="mt-2 text-xs text-zinc-500">正在读取…</p>}
    </section>
  );
}
