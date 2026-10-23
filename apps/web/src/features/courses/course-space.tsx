"use client";

import { TransitionLink as Link } from "../opening/v3/motion/view-transition";
import { useConversationObjectHref } from "../opening/assistant/conversation-object-context";
import { PageHeader, ui } from "../opening/design/ui";
import { useCourseStudySummary } from "./course-study-actions";
import { courseStudyHref, courseStudyTasks, currentCourseActivity } from "./course-study-model";

/** Course facts and resume target share the overview's existing read model. */
export function CourseSpaceHeader({ courseId, title, archived = false }: { courseId: string; title: string; archived?: boolean }) {
  const objectHref = useConversationObjectHref();
  const study = useCourseStudySummary();
  const current = study ? currentCourseActivity(study.activities, courseId) : null;
  const next = study ? courseStudyTasks(study.tasks, courseId)[0] : null;
  const href = current ? courseStudyHref(courseId, current.id) : next ? `${courseStudyHref(courseId)}?task=${encodeURIComponent(next.id)}` : courseStudyHref(courseId);
  return <PageHeader title={title} actions={<div className="flex flex-wrap items-center gap-3">
    {study?.goal?.targetDate ? <span className="text-sm text-text-2">目标 <time dateTime={study.goal.targetDate}>{study.goal.targetDate}</time></span> : null}
    {!archived ? <Link className={ui.primary} href={objectHref(href)}>{current ? "继续" : next ? "开始下一项" : "开始学习"}</Link> : <span className="text-sm text-text-2">已归档</span>}
    <Link className={ui.quiet} href="/opening/courses">全部课程</Link>
  </div>} />;
}
