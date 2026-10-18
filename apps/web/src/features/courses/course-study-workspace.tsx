"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LearningResume, MatrixExerciseSpec } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../opening/client/api";
import { LearningAttemptForm } from "../opening/learning/attempt-form";
import { retestPrefillFromProjection } from "../opening/learning/retest-attempt";
import { LoadError, LoadingRows, ui } from "../opening/design/ui";
import { TeachingContinueEntry } from "../opening/teaching/teaching-workspace";
import { courseActivityNextStep } from "./course-study-model";
import { openCourseStudy, type CompletedRetestTask, type CourseStudyEntry } from "./course-study-entry";
import { useCourseBundle } from "./course-detail";
import { CourseStudyMaterials } from "./course-study-materials";
import { CourseStudyContextTools } from "./course-study-context-tools";

export function CourseRetestReview({ courseId, task }: { courseId: string; task: CompletedRetestTask }) {
  return <section className="space-y-3 px-5 py-6" aria-labelledby="course-retest-review-heading">
    <h2 className="text-sm font-semibold" id="course-retest-review-heading">补测已完成 · 只读回顾</h2>
    <p className="break-words text-sm font-medium text-zinc-800">{task.title}</p>
    <p className="text-xs text-zinc-500">补测主题：{task.retest.skillLabel}</p>
    <p className="whitespace-pre-wrap break-words text-sm leading-7 text-zinc-700">{task.retest.prompt}</p>
    <p className="text-xs leading-6 text-zinc-500">这项补测任务已结束。已保存的作答与核验结果可在课程学习记录中查看。</p>
    <Link className={ui.primary} href={`/opening/courses/${encodeURIComponent(courseId)}#course-learning-records`}>查看学习记录</Link>
  </section>;
}

export function CourseStudyWorkspace({ courseId, activityId, taskId, retestId, teachingEnabled, teachingCompileEnabled, sourceIds, sourceLoadError = false, timeZone, api: suppliedApi, initialMode, initialMatrixKey, initialMatrixVariant, practiceEntryError }: {
  courseId: string; activityId?: string; taskId?: string; retestId?: string; teachingEnabled: boolean; teachingCompileEnabled: boolean;
  sourceIds: string[]; sourceLoadError?: boolean; timeZone: string; api?: OpeningApi;
  initialMode?: "practice" | "matrix"; initialMatrixKey?: MatrixExerciseSpec["exerciseKey"]; initialMatrixVariant?: number; practiceEntryError?: string;
}) {
  const { course, loading, error, reload } = useCourseBundle(courseId);
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const [entry, setEntry] = useState<CourseStudyEntry | null>(null);
  const [resume, setResume] = useState<LearningResume | null>(null);
  const [entryError, setEntryError] = useState("");
  const [resumeError, setResumeError] = useState("");
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const [practice, setPractice] = useState(!teachingEnabled || Boolean(initialMode));
  const courseHref = `/opening/courses/${encodeURIComponent(courseId)}`;
  const archived = Boolean(course?.archivedAt);
  useEffect(() => {
    if (!course) { setBusy(false); return; }
    if (practiceEntryError) { setBusy(false); setEntryError(practiceEntryError); return; }
    if (initialMode) { setEntry({ kind: "practice" }); setBusy(false); return; }
    let active = true;
    setBusy(true); setEntryError(""); setResumeError(""); setEntry(null); setResume(null);
    void openCourseStudy(api, { courseId, courseTitle: course.title, activityId, taskId, retestId, archived, teachingEnabled,
      compilerEnabled: teachingCompileEnabled && !sourceLoadError, sourceIds }).then(async next => {
      if (!active) return;
      setEntry(next);
      if (next.kind === "activity") {
        try {
          const restored = await api.getTeachingResume(next.activity.id);
          if (restored.activityId !== next.activity.id) throw new Error("学习断点不匹配，请重新读取。");
          if (active) { setResume(restored); setEntry({ kind: "activity", activity: { ...next.activity, status: restored.status, generateStatus: restored.generateStatus, contentVersion: restored.contentVersion, pathVersion: restored.pathVersion } }); }
        } catch (reason) { if (active) setResumeError(reason instanceof Error ? reason.message : "学习位置暂时无法读取，请重试。"); }
      } else if (next.kind === "practice") setPractice(true);
    }).catch(reason => { if (active) setEntryError(reason instanceof Error ? reason.message : "学习活动暂时无法读取，请重试。"); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [activityId, api, archived, course, courseId, revision, sourceIds, sourceLoadError, taskId, retestId, teachingCompileEnabled, teachingEnabled, initialMode, practiceEntryError]);

  if (loading) return <LoadingRows label="正在读取课程…" />;
  if (error || !course) return <div className="p-5"><Link className={ui.quiet} href={courseHref}>返回课程</Link><LoadError message={error || "找不到这门课程。"} onRetry={reload} /></div>;
  const retest = entry?.kind === "practice" && entry.task?.retest;
  const retestPrefill = retest ? retestPrefillFromProjection(retest) : null;
  const activity = entry?.kind === "activity" ? entry.activity : null;
  return <main className="flex h-full min-h-0 flex-col bg-white text-zinc-800" data-course-study={courseId}>
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
      <Link className={ui.quiet} href={courseHref}><ArrowLeft aria-hidden="true" size={14} />返回课程</Link>
      <h1 className="min-w-0 flex-1 break-words text-sm font-medium">{course.title}</h1>
      <Link className={ui.quiet} href={`/opening/library?tab=materials&courseId=${encodeURIComponent(courseId)}`}>课程材料</Link>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-6xl pb-10">
      {archived ? <div className="space-y-3 px-5 pt-4"><p className="text-sm leading-6 text-zinc-600">课程已归档，材料与历史记录仍保留。恢复课程后可继续主讲和记录新作答。</p><Link className={ui.secondary} href={`${courseHref}#course-settings-heading`}>返回课程设置以恢复</Link></div> : null}
      {sourceLoadError ? <p className="px-5 pt-4 text-xs leading-6 text-amber-800" role="status">课程材料暂时无法核实，暂不创建新讲解。可独立练习，或重新进入本页。</p> : null}
      {busy ? <LoadingRows label="正在恢复本课程的学习位置…" /> : null}
      {entryError ? <div className="p-5"><LoadError message={entryError} onRetry={() => setRevision(value => value + 1)} /><button className={`${ui.secondary} mt-3`} onClick={() => setPractice(true)} type="button">先独立练习</button></div> : null}
      {!busy && activity && !archived ? <div>
        <p role="status" className="px-5 pt-4 text-xs leading-6 text-zinc-500">{courseActivityNextStep(activity)}</p>
        {resumeError ? <div className="p-5"><LoadError message={resumeError} onRetry={() => setRevision(value => value + 1)} /></div> : <CourseStudyMaterials gate={resume?.gates.materials ?? "unavailable"} materialsHref={`/opening/library?tab=materials&courseId=${encodeURIComponent(courseId)}`} onRetry={() => setRevision(value => value + 1)}><TeachingContinueEntry key={`${activity.id}:${revision}`} activity={activity} resume={resume} initialClientInit={resume?.clientInit} startInWorkspace={Boolean(resume?.clientInit)} teachingCompileEnabled={teachingCompileEnabled && !archived} api={api} timeZone={timeZone} contextualTools={context => <CourseStudyContextTools key={`${context.activity.id}:${context.contentVersion}:${context.blockId}`} context={context} />} onActivityUpdated={updated => setEntry({ kind: "activity", activity: updated })} /></CourseStudyMaterials>}
        {activity.status === "completed" || activity.status === "skipped" ? <div className="px-5 pb-4"><Link className={ui.secondary} href={`/opening/courses/${encodeURIComponent(courseId)}/study?after=${encodeURIComponent(activity.id)}`}>开始下一次学习</Link></div> : null}
      </div> : null}
      {!busy && entry?.kind === "cards" && !archived ? <div className="space-y-3 p-5"><h2 className="text-sm font-semibold">{entry.task.title}</h2><p className="text-sm text-zinc-600">这项任务需要复习已有卡片。</p><Link className={ui.primary} href="/opening/cards">开始卡片复习</Link></div> : null}
      {!busy && entry?.kind === "retest-review" ? <CourseRetestReview courseId={courseId} task={entry.task} /> : null}
      {!busy && !archived && entry?.kind !== "retest-review" && (practice || !teachingEnabled) ? <section id="course-practice" className="space-y-4 px-5 py-6" aria-labelledby="course-practice-heading"><div><h2 className="text-sm font-semibold" id="course-practice-heading">{retestPrefill ? "独立补测" : "独立练习"}</h2><p className="mt-1 text-xs leading-6 text-zinc-500">选主题 → 作答 → 保存。先保留自己的尝试，再获取参考；没有目标或材料也可以开始。</p></div><LearningAttemptForm key={retestPrefill?.retestId ?? courseId} courseId={courseId} retest={retestPrefill} initialMode={initialMode} initialMatrixKey={initialMatrixKey} initialMatrixVariant={initialMatrixVariant} onRecorded={() => undefined} /></section> : null}
      {!practice && teachingEnabled && !archived && entry?.kind !== "retest-review" ? <details className="mx-5 mt-4 border-t border-zinc-200 pt-3"><summary className="cursor-pointer py-1 text-xs text-zinc-500 focus-visible:ring-2 focus-visible:ring-emerald-700">其他学习方式</summary><div className="mt-3 flex flex-wrap gap-2"><button type="button" className={ui.secondary} onClick={() => setPractice(true)}>独立练习</button><Link className={ui.quiet} href={`/opening/assistant?courseId=${encodeURIComponent(courseId)}`}>自由探索</Link></div></details> : null}
    </div></div>
  </main>;
}
