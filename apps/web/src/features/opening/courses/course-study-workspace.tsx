"use client";

import { TransitionLink as Link } from "../v3/motion/view-transition";
import { ArrowLeft, FolderOpen, NotebookPen, Sparkles } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { LearningResume, MatrixExerciseSpec } from "@aistudy/contracts";
import { createOpeningApi, type OpeningApi } from "../client/api";
import { LearningAttemptForm } from "../learning/attempt-form";
import { retestPrefillFromProjection } from "../learning/retest-attempt";
import { ContentBlock, LoadError, LoadingRows, ui } from "../design/ui";
import { TeachingContinueEntry } from "../teaching/teaching-workspace";
import { openCourseStudy, type CompletedRetestTask, type CourseStudyEntry } from "./course-study-entry";
import { useCourseBundle } from "./course-detail";
import { CourseStudyMaterials } from "./course-study-materials";
import { conversationObjectHref } from "../assistant/conversation-links";
import { CourseStudyContextTools } from "./course-study-context-tools";
import { builtInLessonsForCourse } from "./built-in-lessons";
import { TopBar, TopBarTools } from "../v3/shell/top-bar";
import { ui as v3ui } from "../v3/ui/controls";
import { SplitControls, SplitView, type SplitPanes } from "../v3/workspace/split-view";
import { AssistantSession } from "../assistant/assistant-session";
import { assistantEntry } from "../assistant/assistant-entry";
import { OriginalConversationSlot } from "../assistant/conversation-companion";
import { StudyNotePanel } from "../teaching/study-context-tools";
import { MaterialLibrary } from "../library/material-library";
import { userFacingMessage } from "../../../lib/user-facing-error";

export function CourseRetestReview({ courseId, task }: { courseId: string; task: CompletedRetestTask }) {
  return <section className="space-y-3 px-5 py-6" aria-labelledby="course-retest-review-heading">
    <h2 className="text-sm font-semibold" id="course-retest-review-heading">补测已完成 · 只读回顾</h2>
    <p className="break-words text-sm font-medium text-text">{task.title}</p>
    <p className="text-xs text-text-3">补测主题：{task.retest.skillLabel}</p>
    <p className="whitespace-pre-wrap break-words text-sm leading-7 text-text-2">{task.retest.prompt}</p>

    <Link className={ui.primary} href={`/opening/courses/${encodeURIComponent(courseId)}#course-learning-records`}>查看学习记录</Link>
  </section>;
}

export function CourseStudyWorkspace({ courseId, activityId, taskId, retestId, teachingEnabled, teachingCompileEnabled, sourceIds, sourceLoadError = false, timeZone, api: suppliedApi, initialMode, initialMatrixKey, initialMatrixVariant, practiceEntryError, initialFocus, historicalAnchor, historicalAnchorError, originalConversationId }: {
  historicalAnchor?: { blockId: string; contentVersion: number }; historicalAnchorError?: string; originalConversationId?: string | null;
  courseId: string; activityId?: string; taskId?: string; retestId?: string; teachingEnabled: boolean; teachingCompileEnabled: boolean;
  sourceIds: string[]; sourceLoadError?: boolean; timeZone: string; api?: OpeningApi;
  initialFocus?: { skillLabel: string; requirementKey: string | null };
  initialMode?: "practice" | "matrix"; initialMatrixKey?: MatrixExerciseSpec["exerciseKey"]; initialMatrixVariant?: number; practiceEntryError?: string;
}) {
  const { course, loading, error, reload } = useCourseBundle(courseId);
  const api = useMemo(() => suppliedApi ?? createOpeningApi(), [suppliedApi]);
  const [allowCurrentAnchor, setAllowCurrentAnchor] = useState(false);
  const [entry, setEntry] = useState<CourseStudyEntry | null>(null);
  const [resume, setResume] = useState<LearningResume | null>(null);
  const [entryError, setEntryError] = useState("");
  const [resumeError, setResumeError] = useState("");
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [previousToolsAvailable, setPreviousToolsAvailable] = useState(false);
  const [restoringPreviousTools, setRestoringPreviousTools] = useState(false);
  useEffect(() => setRestoringPreviousTools(false), [activityId, workspaceReady]);
  const [practice, setPractice] = useState(!teachingEnabled || Boolean(initialMode));
  const [practiceVisited, setPracticeVisited] = useState(!teachingEnabled || Boolean(initialMode));
  const openPractice = () => { setPracticeVisited(true); setPractice(true); };
  const courseHref = conversationObjectHref(`/opening/courses/${encodeURIComponent(courseId)}`, originalConversationId);
  const archived = Boolean(course?.archivedAt);
  const spanLesson = builtInLessonsForCourse(courseId, course).find(lesson => lesson.id === "span");
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
        } catch (reason) { if (active) setResumeError(userFacingMessage(reason, "学习位置暂时无法读取，请重试。")); }
      } else if (next.kind === "practice") { setPracticeVisited(true); setPractice(true); }
    }).catch(reason => { if (active) setEntryError(userFacingMessage(reason, "学习活动暂时无法读取，请重试。")); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [activityId, api, archived, course, courseId, revision, sourceIds, sourceLoadError, taskId, retestId, teachingCompileEnabled, teachingEnabled, initialMode, practiceEntryError]);

  const pathname = usePathname() ?? "";
  const courseTitle = course?.title ?? "本课";
  // 右侧分栏：对话（本课背景）/ 笔记 / 资料。内容按需渲染，关掉的栏不占资源。
  const panes = useMemo<SplitPanes>(() => ({
    assistant: { label: "对话", icon: <Sparkles size={14} />, render: () => <div className="flex h-full min-h-0 flex-col">{originalConversationId ? <OriginalConversationSlot conversationId={originalConversationId} /> : <AssistantSession entry={assistantEntry(`/opening/assistant?courseId=${encodeURIComponent(courseId)}`, pathname)} />}</div> },
    notes: { label: "笔记", icon: <NotebookPen size={14} />, render: () => <div className="px-4 pb-4"><StudyNotePanel key={courseId} context={{ courseId, label: courseTitle }} /></div> },
    sources: { label: "资料", icon: <FolderOpen size={14} />, render: () => <div className="px-4 pb-4"><MaterialLibrary api={api} courseId={courseId} /></div> },
  }), [api, courseId, courseTitle, pathname, originalConversationId]);
  if (loading) return <LoadingRows label="正在读取课程…" />;
  if (error || !course) return <div className="p-5"><Link className={ui.quiet} href={courseHref}>返回课程</Link><LoadError message={error || "找不到这门课程。"} onRetry={reload} /></div>;
  const retest = entry?.kind === "practice" ? entry.task?.retest : null;
  const retestPrefill = retest ? retestPrefillFromProjection(retest) : null;
  const activity = entry?.kind === "activity" ? entry.activity : null;

  const anchorProblem = historicalAnchorError || (historicalAnchor && resume && (historicalAnchor.contentVersion !== resume.contentVersion || resume.clientInit?.checkpointJson?.currentBlockId !== historicalAnchor.blockId) ? "这条笔记对应的是这节课的旧内容或别的位置。笔记仍保留；可以回到笔记看看，或继续当前位置学习。" : "");
  const readyTeaching = workspaceReady && !practice && !busy && !archived && !resumeError
    && (!anchorProblem || allowCurrentAnchor) && (resume?.gates.materials === "available" || resume?.gates.materials === "partial");
  return <section aria-label="课程学习台" className="flex h-full min-h-0 flex-col bg-surface text-text" data-course-study={courseId}>
    {!readyTeaching ? <TopBar label="课程学习顶栏"
      leading={<Link className={v3ui.icon} href={courseHref} aria-label="返回课程"><ArrowLeft aria-hidden="true" size={18} /></Link>}
      title={<h1 className="truncate text-title font-semibold tracking-[-0.01em]">{course.title}</h1>}
      actions={<TopBarTools label="学习工具">
        {!resume?.clientInit && teachingEnabled && spanLesson ? <Link className={`${v3ui.toolbarButton} hidden sm:inline-flex`} href={conversationObjectHref(spanLesson.href, originalConversationId)}>自学 / 串讲 / 挑战</Link> : null}
        <SplitControls panes={panes} />
      </TopBarTools>} /> : null}
    <div className="min-h-0 flex-1"><SplitView panes={panes} suspended={readyTeaching} restoring={readyTeaching && restoringPreviousTools} onSuspendedPaneAvailable={setPreviousToolsAvailable} onRestoreClose={() => setRestoringPreviousTools(false)}><div className={`h-full min-h-0 ${activity && !practice ? "flex flex-col overflow-hidden" : "overflow-y-auto [scrollbar-gutter:stable]"}`}><div className={activity && !practice ? "flex min-h-0 w-full flex-1 flex-col" : "w-full pb-10"}>
      {archived ? <div className="space-y-3 px-5 pt-4"><p className="text-sm leading-6 text-text-2">课程已归档。</p><Link className={ui.secondary} href={`${courseHref}#course-settings-heading`}>返回课程设置以恢复</Link></div> : null}
      {sourceLoadError ? <p className="px-5 pt-4 text-xs leading-6 text-warn" role="status">课程材料暂时无法核实，暂不创建新讲解。可独立练习，或重新进入本页。</p> : null}
      {busy ? <LoadingRows label="正在恢复本课程的学习位置…" /> : null}
      {entryError ? <div className="p-5"><LoadError message={entryError} onRetry={() => setRevision(value => value + 1)} /><button className={`${ui.secondary} mt-3`} onClick={openPractice} type="button">先独立练习</button></div> : null}
      {!busy && activity && !archived ? <div hidden={practice} className={practice ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        {anchorProblem && !allowCurrentAnchor ? <div className="space-y-3 p-5" role="status"><p className="text-sm leading-7 text-warn">{anchorProblem}</p><button type="button" className={ui.secondary} onClick={() => setAllowCurrentAnchor(true)}>继续当前断点</button></div> : resumeError ? <div className="p-5"><LoadError message={resumeError} onRetry={() => setRevision(value => value + 1)} /></div> : <CourseStudyMaterials gate={resume?.gates.materials ?? "unavailable"} materialsHref={`/opening/library?tab=materials&courseId=${encodeURIComponent(courseId)}`} onRetry={() => setRevision(value => value + 1)}><TeachingContinueEntry key={`${activity.id}:${revision}`} activity={activity} resume={resume} initialClientInit={resume?.clientInit} startInWorkspace={Boolean(resume?.clientInit)} teachingCompileEnabled={teachingCompileEnabled && !archived} api={api} timeZone={timeZone} originalConversationId={originalConversationId} onWorkspaceVisibilityChange={setWorkspaceReady} previousToolsAction={previousToolsAvailable ? <button type="button" className={ui.secondary} onClick={() => setRestoringPreviousTools(true)}>返回课前工具</button> : null} headerLeading={<Link className={v3ui.icon} href={courseHref} aria-label="返回课程"><ArrowLeft aria-hidden="true" size={18} /></Link>} contextualTools={context => <CourseStudyContextTools key={`${context.activity.id}:${context.contentVersion}:${context.blockId}`} context={context} />} onActivityUpdated={updated => setEntry({ kind: "activity", activity: updated })} /></CourseStudyMaterials>}
        {activity.status === "completed" || activity.status === "skipped" ? <div className="px-5 pb-4"><Link className={ui.secondary} href={conversationObjectHref(`/opening/courses/${encodeURIComponent(courseId)}/study?after=${encodeURIComponent(activity.id)}`, originalConversationId)}>开始下一次学习</Link></div> : null}
      </div> : null}
      {!busy && entry?.kind === "cards" && !archived ? <div className="space-y-3 p-5"><h2 className="text-sm font-semibold">{entry.task.title}</h2><Link className={ui.primary} href="/opening/cards">开始卡片复习</Link></div> : null}
      {!busy && entry?.kind === "retest-review" ? <CourseRetestReview courseId={courseId} task={entry.task} /> : null}

      {!busy && !archived && entry?.kind !== "retest-review" && practiceVisited ? <section hidden={!practice && teachingEnabled} id="course-practice" className={!practice && teachingEnabled ? "hidden" : "space-y-4 px-5 py-6"} aria-labelledby="course-practice-heading"><ContentBlock width={initialMode === "matrix" ? "wide" : "prose"}><div className="flex items-center justify-between gap-3"><h2 className="text-ui-lg font-semibold" id="course-practice-heading">{retestPrefill ? "独立补测" : "独立练习"}</h2>{activity ? <button type="button" className={ui.quiet} onClick={() => setPractice(false)}>返回讲解</button> : null}</div>{retest?.requirementKey === "span:linear-combination:v1" ? <Link className={ui.primary} href={`/opening/courses/${courseId}/study/span?retest=${retest.candidateId}`}>开始 span 正式延迟复测</Link> : <LearningAttemptForm key={retestPrefill?.retestId ?? courseId} courseId={courseId} retest={retestPrefill} initialFocus={initialFocus} initialMode={initialMode} initialMatrixKey={initialMatrixKey} initialMatrixVariant={initialMatrixVariant} onRecorded={() => undefined} />}</ContentBlock></section> : null}
      {!practice && teachingEnabled && !archived && entry?.kind !== "retest-review" ? (() => {
        // 讲解还没准备好（排队、生成中或本环境未开放生成）时，不让学习者对着状态卡干等：把能马上开始的事直接摆出来。
        const waiting = !busy && !entryError && !resume?.clientInit && !workspaceReady;
        return waiting ? <details key="waiting" open={waiting} className="mx-5 mt-2 shrink-0 border-t border-line pb-3 pt-2" data-study-alternatives={waiting ? "waiting" : "ready"}><summary className="cursor-pointer py-1 text-xs text-text-3 focus-visible:ring-2 focus-visible:ring-focus-ring">{waiting ? "讲解准备好之前，可以先做这些" : "其他学习方式"}</summary><div className="mt-3 flex flex-wrap gap-2">{spanLesson ? <Link className={waiting ? ui.primary : ui.secondary} href={conversationObjectHref(spanLesson.href, originalConversationId)}>学现成的一节：{spanLesson.label}</Link> : <Link className={waiting ? ui.primary : ui.secondary} href={conversationObjectHref(`/opening/library?tab=materials&courseId=${encodeURIComponent(courseId)}`, originalConversationId)}>先读课程材料</Link>}<button type="button" className={ui.secondary} onClick={openPractice}>独立练习</button><Link className={ui.quiet} href={conversationObjectHref(`/opening/assistant?courseId=${encodeURIComponent(courseId)}`, originalConversationId)}>问 AI</Link></div></details> : null;
      })() : null}
    </div></div></SplitView></div>
  </section>;
}
